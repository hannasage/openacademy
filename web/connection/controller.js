import { discoverHub, validateHub, uuid } from "./discovery.js";
import { projectPublication } from "../publication.js";
const HUB_KEY = "touchline-hub:v1", RETURN_KEY = "touchline-account-return:v1";
/** @param {unknown} error */
const message = (error) => error instanceof Error ? error.message : String(error);
class ConnectionController {
  /** @param {import("./types").Dependencies} deps */
  constructor(deps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }
  deps;
  /** @type {import("./types").ConnectionState} */
  state = { phase: "disconnected", hub: null, candidate: null, busy: false, error: false, message: "Your learning stays available on this computer.", email: "", resendAt: 0, courses: [], sessions: [], accountId: null, currentSessionId: null, needsSignOut: false, needsVerificationRetry:false, unavailableCourses:0 };
  listeners = /* @__PURE__ */ new Set();
  /** @type {import("@supabase/supabase-js").SupabaseClient | null} */
  client = null;
  epoch = 0;
  authRevision = 0;
  operation = 0;
  unsubscribe = () => {
  };
  /** @type {Record<string, number>} */
  revisions = {};
  /** @type {() => number} */
  now;
  getSnapshot = () => this.state;
  /** @param {() => void} listener */
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  /** @param {Partial<import("./types").ConnectionState>} value */
  update(value) {
    this.state = { ...this.state, ...value };
    for (const listener of this.listeners) listener();
  }
  /** @param {number} epoch */
  check(epoch) {
    if (epoch !== this.epoch) throw Error("The connection changed. Start this operation again.");
  }
  /** @param {() => Promise<void>} work */
  async run(work) {
    if (this.state.busy) {
      this.update({ message: "Wait for the current request to finish.", error: true });
      return false;
    }
    const operation = ++this.operation;
    this.update({ busy: true, error: false });
    try {
      await work();
      return true;
    } catch (error) {
      if (operation === this.operation) this.update({ message: message(error), error: true });
      return false;
    } finally {
      if (operation === this.operation) this.update({ busy: false });
    }
  }
  backend() {
    if(!this.client) throw Error("Find and confirm your hub first.");
    return this.client;
  }
  hub() {
    if (!this.state.hub || !this.client) throw Error("Find and confirm your hub first.");
    return this.state.hub;
  }
  clearAccount() {
    this.epoch += 1;
    this.revisions = {};
    this.update({ needsVerificationRetry:false, accountId: null, currentSessionId: null, courses: [], sessions: [], unavailableCourses:0, phase: this.state.hub ? "signin" : "disconnected" });
  }
  async invalidate() {
    this.clearAccount();
    await this.deps.accounts.invalidateAccountScope();
  }
  /** @param {import("./types").Hub} hub */
  install(hub) {
    this.unsubscribe();
    this.client = this.deps.makeClient(hub);
    const client = this.client;
    let observedToken = /** @type {string|null} */(null);
    const { data } = client.auth.onAuthStateChange((event, session) => {
      if (client !== this.client) return;
      const nextToken=session?.access_token??null;
      if(event!=='INITIAL_SESSION' && nextToken!==observedToken)this.authRevision+=1;
      observedToken=nextToken;
      if (event === "SIGNED_OUT" || this.state.accountId && session?.user.id !== this.state.accountId) {
        const invalidation=this.invalidate();
        const invalidatedEpoch=this.epoch;
        void invalidation.then(()=>{if(this.client===client && this.epoch===invalidatedEpoch)this.update({message:'The account session ended. Private records are hidden.'});}).catch(error=>{if(this.client===client && this.epoch===invalidatedEpoch)this.update({message:message(error),error:true});});
      }
    });
    this.unsubscribe = () => data.subscription.unsubscribe();
    this.update({ hub, phase: "signin", candidate: null, email: "", resendAt: 0 });
  }
  /** @param {string} address */
  find = (address) => this.run(async () => {
    const epoch = this.epoch;
    const candidate = await discoverHub(address, this.deps.request);
    this.check(epoch);
    this.update({ candidate, phase: "review", message: "Confirm the hub name and both addresses before signing in." });
  });
  confirm = () => this.run(async () => {
    if (this.state.needsSignOut) throw Error("Finish signing out before changing hubs.");
    if (!this.state.candidate) throw Error("Find your hub first.");
    const next = validateHub(this.state.candidate);
    await this.deps.accounts.setAccountScope(null);
    if (this.client) {
      const { error } = await this.backend().auth.signOut({ scope: "local" });
      if (error) throw error;
    }
    this.clearAccount();
    this.deps.transient.removeItem(RETURN_KEY);
    this.install(next);
    try {
      this.deps.storage.setItem(HUB_KEY, JSON.stringify(next));
      this.update({ message: "Hub confirmed. Sign in with your email." });
    } catch {
      this.update({ message: "Hub confirmed for this visit. This browser could not remember its address.", error: true });
    }
  });
  useDifferentHub = () => this.run(async () => {
    if (this.state.needsSignOut) throw Error("Finish signing out before changing hubs.");
    await this.deps.accounts.setAccountScope(null);
    if (this.client) {
      const { error } = await this.backend().auth.signOut({ scope: "local" });
      if (error) throw error;
    }
    this.clearAccount();
    this.unsubscribe();
    this.client = null;
    this.deps.storage.removeItem(HUB_KEY);
    this.deps.transient.removeItem(RETURN_KEY);
    this.update({ hub: null, candidate: null, phase: "disconnected", email: "", resendAt: 0, message: "Enter the address of your other hub." });
  });
  /** @param {unknown} error @param {number} [status] */
  async verificationFailed(error, status) {
    const detail = /** @type {{status?:number;code?:string}|null} */(error);
    const denied = status === 401 || status === 403 || detail?.status === 401 || detail?.status === 403 || detail?.code === '42501';
    await this.invalidate();
    this.update({ needsSignOut:denied, needsVerificationRetry:!denied });
    throw Error(denied
      ? 'This session cannot access this private hub. Sign out, then use your owner account or another hub.'
      : 'Account verification is temporarily unavailable. Private records are hidden. Retry the connection. Your local learning stays available.');
  }
  /** @template {{error:unknown;status?:number}} T @param {()=>PromiseLike<T>} request @param {()=>void} check @returns {Promise<T>} */
  async verificationRequest(request, check) {
    let result;
    try { result = await request(); }
    catch(error) { check(); await this.verificationFailed(error); throw error; }
    check();
    if(result.error) await this.verificationFailed(result.error, result.status);
    return result;
  }
  retryVerification = () => this.run(async () => {
    if(this.state.needsSignOut) throw Error('Finish signing out before starting another sign-in.');
    await this.loadPrivate();
    this.update({message:'Connection restored. Your private records are available.'});
  });
  async verified(register = true) {
    const hub = this.hub(), client = this.backend(), epoch = this.epoch;
    const authRevision=this.authRevision;
    const check=()=>{this.check(epoch);if(this.authRevision!==authRevision)throw Error('The account session changed. Retry this request.');};
    const sessionResult = await this.verificationRequest(()=>client.auth.getSession(),check);
    check();
    const session = sessionResult.data.session;
    if (sessionResult.error || !session?.access_token) {
      await this.invalidate();
      throw Error("Sign in to access your private records.");
    }
    const { data } = await this.verificationRequest(()=>client.auth.getUser(session.access_token),check);
    check();
    const user = data.user;
    if (!user || !uuid.test(user.id) || user.id !== session.user.id || !user.email_confirmed_at || user.is_anonymous) {
      await this.invalidate();
      this.update({ needsSignOut: true });
      throw Error("This account cannot access this private hub. Sign out, then use your owner account or another hub.");
    }
    const transfer = this.deps.makeClient(hub, session.access_token);
    const authResult = await this.verificationRequest(()=>transfer.rpc("register_touchline_session", { device_label: "Touchline web browser" }),check);
    check();
    if (!authResult.data || authResult.data.accountId !== user.id || !uuid.test(authResult.data.sessionId)) await this.verificationFailed(null);
    const origin = /** @type {CloudOrigin} */({ kind: "cloud", hubId: hub.hubId, backendOrigin: hub.backend.url, accountId: user.id });
    if (register) {
      await this.deps.accounts.setAccountScope(origin);
      try {check();}
      catch(error) {await this.invalidate();throw error;}
      this.update({ needsVerificationRetry:false, accountId: user.id, currentSessionId: authResult.data.sessionId, phase: "ready" });
      this.loadRevisions(user);
    }
    return { transfer, origin, epoch, user, sessionId: authResult.data.sessionId };
  }
  /** @param {import("@supabase/supabase-js").User} user */
  loadRevisions(user) {
    const key = "touchline-revisions:" + this.hub().hubId + ":" + this.hub().backend.url + ":" + user.id;
    try {
      const values = JSON.parse(this.deps.storage.getItem(key) || "{}");
      this.revisions = /** @type {Record<string, number>} */(Object.fromEntries(Object.entries(values).filter(([, v]) => Number.isSafeInteger(v) && Number(v) >= 0)));
    } catch {
      this.revisions = {};
    }
  }
  saveRevisions() {
    try {
      this.deps.storage.setItem("touchline-revisions:" + this.hub().hubId + ":" + this.hub().backend.url + ":" + this.state.accountId, JSON.stringify(this.revisions));
    } catch {
      throw Error("The transfer finished, but its revision could not be saved. Download the latest copy before publishing again.");
    }
  }
  /** @param {string} email */
  requestCode = (email) => this.run(async () => {
    this.hub();
    if (this.state.needsSignOut) throw Error("Finish signing out before starting another sign-in.");
    const normalized = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 254) throw Error("Enter your email address.");
    if (this.now() < this.state.resendAt) throw Error("Wait one minute before requesting another code.");
    await this.deps.accounts.setAccountScope(null);
    const epoch = this.epoch;
    const { error } = await this.backend().auth.signInWithOtp({ email: normalized, options: { shouldCreateUser: true } });
    this.check(epoch);
    if (error) throw Error(error.status === 429 ? "Too many requests. Wait before requesting another code." : "The code could not be sent. Confirm the address and try again.");
    this.update({ email: normalized, phase: "code", resendAt: this.now() + 6e4, message: "If this address is allowed, a sign-in code is on its way." });
  });
  useAnotherEmail = () => {
    if (this.state.busy) return;
    this.update({ phase: "signin", email: "", message: "Enter your owner email." });
  };
  /** @param {string} token */
  verifyCode = (token) => this.run(async () => {
    this.hub();
    if (!this.state.email || !/^[0-9]{6,10}$/.test(token)) throw Error("Enter the sign-in code from your email.");
    const epoch = this.epoch;
    const { error } = await this.backend().auth.verifyOtp({ email: this.state.email, token, type: "email" });
    this.check(epoch);
    if (error) throw Error("That code is invalid or expired. Request another code and try again.");
    await this.verified();
    await this.loadPrivate();
    this.update({ message: "Signed in. Your records are private to this account." });
  });
  /** @returns {import("./types").PendingOAuth | null} */
  pending() {
    const raw = this.deps.transient.getItem(RETURN_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  }
  /** @param {"google" | "apple"} provider */
  startProvider = (provider) => this.run(async () => {
    const hub = this.hub();
    if (this.state.needsSignOut) throw Error("Finish signing out before starting another sign-in.");
    if (!hub.auth.providers.includes(provider)) throw Error("This sign-in method is not enabled by your hub.");
    await this.deps.accounts.setAccountScope(null);
    const nonce = crypto.randomUUID(), callback = this.deps.appOrigin + "/auth/return?touchline-return=" + nonce;
    const pending = { nonce, hubId: hub.hubId, backendOrigin: hub.backend.url, callback, expiresAt: this.now() + 6e5 };
    this.deps.transient.setItem(RETURN_KEY, JSON.stringify(pending));
    const epoch = this.epoch;
    const { data, error } = await this.backend().auth.signInWithOAuth({ provider, options: { redirectTo: callback, skipBrowserRedirect: true } });
    this.check(epoch);
    if (error || !data.url) {
      this.deps.transient.removeItem(RETURN_KEY);
      throw Error("Sign-in could not start. Try again.");
    }
    const destination = new URL(data.url);
    if (destination.origin !== hub.backend.url || destination.pathname !== "/auth/v1/authorize") {
      this.deps.transient.removeItem(RETURN_KEY);
      throw Error("The sign-in destination did not match your backend.");
    }
    this.deps.navigate(destination.href);
  });
  /** @param {URL} url */
  async completeReturn(url) {
    const pending = this.pending();
    this.deps.transient.removeItem(RETURN_KEY);
    const hub = this.hub();
    if (!pending || pending.expiresAt < this.now() || pending.hubId !== hub.hubId || pending.backendOrigin !== hub.backend.url || url.origin !== this.deps.appOrigin || url.pathname !== "/auth/return" || url.searchParams.getAll("touchline-return").length !== 1 || url.searchParams.get("touchline-return") !== pending.nonce) throw Error("This sign-in return is expired or belongs to another hub. Start sign-in again.");
    const allowed=new Set(['touchline-return','code','error','error_code','error_description']);
    if(Array.from(url.searchParams.keys()).some(key=>!allowed.has(key)||url.searchParams.getAll(key).length!==1))throw Error('This sign-in return is invalid. Start again.');
    if (url.searchParams.has("error") || url.searchParams.has("error_description")) throw Error("Sign-in was canceled or denied. Your local learning is unchanged.");
    if (url.searchParams.getAll("code").length !== 1 || !url.searchParams.get("code") || (url.searchParams.get("code") ?? "").length > 4096 || url.hash) throw Error("This sign-in return is invalid. Start again.");
    const epoch = this.epoch;
    const { error } = await this.backend().auth.exchangeCodeForSession(url.searchParams.get("code") ?? "");
    this.check(epoch);
    if (error) throw Error("This sign-in return is expired or already used. Start again.");
    await this.verified();
    await this.loadPrivate();
    this.update({ message: "Signed in. Your records are private to this account." });
  }
  /** @param {string} [returnUrl] */
  initialize = (returnUrl) => this.run(async () => {
    const saved = this.deps.storage.getItem(HUB_KEY);
    if (!saved) {
      if(this.deps.storage.getItem('touchline-backend')) this.update({message:'Your earlier connection details are preserved. Enter your hub address to reconnect. Existing learning files remain unchanged.'});
      return;
    }
    const previous = validateHub(JSON.parse(saved));
    const current = await discoverHub(previous.hubOrigin, this.deps.request);
    if (JSON.stringify(current) !== JSON.stringify(previous)) {
      this.update({ candidate: current, phase: "review", message: "The hub configuration changed. Confirm it before signing in." });
      return;
    }
    this.install(current);
    if (returnUrl) {
      const url = new URL(returnUrl);
      if (url.searchParams.has("touchline-return")) {
        await this.completeReturn(url);
        return;
      }
    }
    const epoch=this.epoch;
    const { data } = await this.verificationRequest(()=>this.backend().auth.getSession(),()=>this.check(epoch));
    if (data.session) {
      await this.verified();
      await this.loadPrivate();
      this.update({ message: "Your saved account session is ready." });
    } else this.update({ message: "Hub confirmed. Sign in with your email." });
  });
  async loadPrivate() {
    const { transfer, epoch } = await this.verified();
    const { data, error } = await transfer.from("learning_courses").select("id,curriculum,revision,updated_at").order("updated_at", { ascending: false });
    this.check(epoch);
    if (error) throw error;
    const inventory = await transfer.rpc("list_touchline_sessions");
    this.check(epoch);
    if (inventory.error) throw inventory.error;
    if (!Array.isArray(inventory.data) || inventory.data.some((/** @type {import("./types").SessionRow} */ row) => !uuid.test(row.sessionId) || typeof row.label !== "string" || typeof row.isCurrent !== "boolean" || row.createdAt !== null && typeof row.createdAt !== "string" || row.lastSeenAt !== null && typeof row.lastSeenAt !== "string")) throw Error("The session list is invalid. Try again.");
    if(!Array.isArray(data))throw Error('The published curriculum list is invalid. Try again.');
    const courses=data.filter(row=>row && typeof row.id==='string' && /^[a-z0-9][a-z0-9-]{0,59}$/.test(row.id) && typeof row.curriculum?.title==='string' && row.curriculum.title.trim() && Number.isSafeInteger(row.revision) && row.revision>=0 && typeof row.updated_at==='string' && Number.isFinite(Date.parse(row.updated_at)));
    this.update({courses,sessions:inventory.data,unavailableCourses:data.length-courses.length});
  }
  refresh = () => this.run(async () => {
    await this.loadPrivate();
    this.update({ message: "Published courses and account sessions refreshed." });
  });
  /** @param {string} sessionId */
  revoke = (sessionId) => this.run(async () => {
    if (!uuid.test(sessionId)) throw Error("Choose a valid session.");
    const { transfer, epoch } = await this.verified();
    const { error } = await transfer.rpc("revoke_touchline_session", { target_session_id: sessionId });
    this.check(epoch);
    if (error) throw error;
    if (sessionId === this.state.currentSessionId) {
      await this.invalidate();
      this.update({ needsSignOut: true });
      const { error: error2 } = await this.backend().auth.signOut({ scope: "local" });
      if (error2) throw error2;
      this.update({ needsSignOut: false });
    } else await this.loadPrivate();
    this.update({ message: "Session access revoked. An offline device clears private copies when it next learns that its session ended." });
  });
  signOut = () => this.run(async () => {
    this.hub();
    await this.deps.accounts.setAccountScope(null);
    await this.invalidate();
    this.update({ needsSignOut: true });
    const result = await this.backend().auth.signOut({ scope: "local" });
    if (result.error) throw Error("Account sign-out failed. Your private records are hidden. Retry sign-out.");
    this.update({ needsSignOut: false, message: "Signed out. Local learning remains on this computer." });
  });
  publish = () => this.run(async () => {
    const { transfer, epoch } = await this.verified();
    const backup = projectPublication(await this.deps.accounts.snapshot());
    this.check(epoch);
    const { data, error } = await transfer.rpc("save_learning_course", { course_id: backup.curriculum.id, course_content: backup.curriculum, course_progress: backup.state, expected_revision: Object.hasOwn(this.revisions, backup.curriculum.id) ? this.revisions[backup.curriculum.id] : -1 });
    this.check(epoch);
    if (error) throw error;
    this.revisions[backup.curriculum.id] = data.revision;
    this.saveRevisions();
    await this.loadPrivate();
    this.update({ message: "Published. Refresh the native app to read this copy." });
  });
  /** @param {string} id */
  download = (id) => this.run(async () => {
    const { transfer, epoch, origin } = await this.verified();
    const { data, error } = await transfer.from("learning_courses").select("*").eq("id", id).single();
    this.check(epoch);
    if (error) throw error;
    const imported = await this.deps.accounts.importCloud({ curriculum: data.curriculum, state: data.progress }, origin);
    this.check(epoch);
    if (!imported) {
      this.update({ message: "Download canceled. Your saved copy is unchanged." });
      return;
    }
    this.revisions[id] = data.revision;
    this.saveRevisions();
    this.update({ message: "Downloaded " + data.curriculum.title });
  });
}
export {
  ConnectionController
};
