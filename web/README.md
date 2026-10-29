# Web boundaries

`web.jsx` creates the only React root.
It owns the theme provider and the header, navigation, resume, and progress controls.
The appearance component stays mounted when learning state changes.

The HTML template in `index.html` holds the current learning and connection views.
The shell clones that template once into its legacy region.
React renders only into the reserved `data-renderer="react"` slots inside that region.
`app.js` can update the other elements, but cannot change those slots or their children.
New screens can replace a legacy region without replacing the shell.

`web/shell/bridge.js` carries shell state and named commands.
Navigation changes its selected view only after the controller accepts the transition.
A failed save keeps the current view and its working copy.
Selecting a view does not change curriculum focus or status.

`web/services/learning.js` handles local requests and structured server errors.
The caller supplies the account scope explicitly for each record operation.
The controller keeps the revision, account-change, and recovery checks around each awaited request.

`web/services/accounts.js` provides the learning operations that the connection view can call.
Its methods cover snapshots, scoped imports, scope changes, invalidation, and downloads.
The current `window.touchline` value is a compatibility facade for those methods.
The connection controller in `web/connection/` handles account discovery, sign-in, session checks, and remote transfers.
`sync.js` starts that controller after the learning bridge is ready.

Run `npm run test:browser` to exercise failed navigation and the retained learning workflows.
Run `npm run test:appearance` to check theme changes without remounting working forms.
The service and bridge unit tests run with `npm test`.

The P04 home and library screens are React portals in `web/screens/`.
They read explicit library focus and complete record metrics through the local service.
Opening a curriculum keeps the focus unchanged.
Status changes and focus changes use revision-checked writes, and failures leave the current learning record intact.
The lesson controller owns the lesson region and uses `web/screens/lesson.js` for its markup.
The connection screen is a React portal in the same shell.
Account invalidation clears private records from the home, library, and lesson views before loading local learning.
Journal, import, and appearance flows retain their existing owners.
