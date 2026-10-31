# Software factory improvement record

Recorded: October 12, 2026.
Status: Recommendations recorded. Implementation and scheduled activation remain separate work.

## Purpose

Reduce the coordination that Hanna must do for each accepted delivery.
Keep one primary delivery lane and one small friction-removal lane as the proposed operating limit.
Use `sage-factory` for manual passes and future routine triggers.

## Improvement register

An unchecked item is recorded work, not a completed change.
The owner names below identify the responsible function, not an assigned live session.

- [ ] F01. Repair workspace references. Owner: project office. Priority: first.
  Point saved projects and routine working directories at the current workbench.
  Acceptance: a fresh session finds the current root and project repositories without an old path lookup.
  Evidence: this Codex project points at `~/Projects/Code/Sage Advice LLC`. The workbench is at `~/Sage Advice`.
- [ ] F02. Reconcile ownership and approval rules. Owner: project office. Priority: first.
  Give each active task one accountable owner and one authoritative approval path.
  Acceptance: root instructions, Sage Ops, and team prompts agree about who can conclude each class of work.
  Preserve existing approval boundaries until the reconciliation receives approval.
- [ ] F03. Prepare acceptance before implementation. Owner: delivery coordinator. Priority: next delivery.
  Record the outcome, exact references, required access, review owner, and evidence before starting the task.
  Acceptance: missing staging access or review assets appear as prerequisites before implementation starts.
- [ ] F04. Separate completion evidence. Owner: gate reviewer. Priority: next delivery.
  Distinguish code completion, technical review, visual review, owner acceptance, and release.
  Acceptance: tests cannot clear a visual gate, and a screenshot cannot clear an interaction or device gate.
  Bind each verdict to its reviewed commit or artifact revision.
- [ ] F05. Prove unattended controls. Owner: engineering. Priority: before scheduled execution.
  Test interruption recovery, retained review counts, duplicate prevention, and refusal after the allowed limit.
  Acceptance: retained trials show these controls on the installed version before unattended work starts.
  The October 5 validation matrix records pending cases, not implemented enforcement.
- [ ] F06. Limit active work and measure delivery. Owner: project office. Priority: first bounded trial.
  Record the primary delivery lane and one small friction-removal lane before dispatch.
  Measure founder interventions, waiting time, review cycles, and defects after release per accepted delivery.
  Acceptance: a weekly comparison names its period, evidence, missing measures, and one justified improvement.
  Use the existing delivery baseline collector for activity. Do not equate merge counts with accepted outcomes.
- [ ] F07. Activate consistent routines through one entry point. Owner: project office. Priority: after F01, F02, and F05.
  Keep the routine design in `.bowerloom/` and use the same `sage-factory` skill for each invocation.
  Acceptance: the trigger uses the current skill, respects task ownership, and preserves existing approval boundaries.
  Scheduling must survive interruption without duplicate work. A recorded schedule is not an active trigger.

## Proposed cadence

These times are proposals in `America/New_York`, with daylight saving time applied.
No schedule is active. Activation requires a selected, supported trigger and a reviewed cadence.

| Routine | Proposed trigger | Skill mode | Result |
| --- | --- | --- | --- |
| Daily kickoff | Weekdays at 9:00 a.m. | `status` | Current lane, owner, prerequisites, blockers, and next action |
| Issue intake | With the daily kickoff, after repository scope is approved | `intake` | New user reports and discussion candidates, with unfinished triage retained |
| Delivery continuation | Weekdays at 11:00 a.m., 1:00 p.m., and 3:00 p.m. | `work` | One bounded step on an already authorized task |
| Weekly improvement review | Friday at 4:00 p.m. | `weekly` | Accepted outcomes, measured friction, and one proposed improvement |

The continuation routine remains disabled until ownership, authorization, and recovery behavior are proven.
If no authorized task is ready, it reports the blocker and starts no replacement lane.
Existing GitHub review and merge workflows retain their own triggers.
The factory routine does not duplicate their review runs or merge decisions.

## One prompt

After Bowerloom projects the skill into the current workbench, use:

```text
Run $sage-factory.
```

The default mode is a read-only status pass.
For the other modes, use `Run $sage-factory work`, `Run $sage-factory weekly`, or `Run $sage-factory setup`.
For issue discovery, use `Run $sage-factory check for new issues submitted`.
For issue management, use `Run $sage-factory triage issues in owner/repo`.
Read [GitHub issue operations](github-issues.md) for bot identities, retained intake, and the future scanner's inputs.
The intake helper writes private progress locally. It changes no GitHub issues.
Discussion scans remain separately scheduled future work, with access and repository scope required before activation.
A future scheduler supplies the same request and an approved task scope.
It does not copy a second set of workflow instructions into its prompt.

## Current support boundary

The installed CLI identifies itself as Bowerloom 0.7.0-beta.1.
Its advanced help exposes `bowerloom routine plan` for a standalone authoring tree.
That command prints a definition plan. It does not install or execute the routine.
The retained routine contract supports one manual Labs-to-blog definition.
It defines no scheduler, trigger, launch operation, or run record.

This factory record is design documentation bundled with the `sage-factory` skill.
It is not a `bowerloom/routine/v1beta1` definition and cannot be passed to that planner.
Do not add unsupported schedule fields to the product's routine format.
Do not modify the startup installation inventory to suggest that these routines are installed.
When support exists, migrate the approved design into its supported format and retain activation evidence.
The intended portable destination is `.bowerloom/routines/` once it supports these factory procedures.
Keep this setup recorded without an alternative scheduler while that support is absent.

## Activation requirements

Before enabling any trigger, make sure that all of these conditions hold:

- The working directory and skill revision identify the current workbench.
- The approved cadence names its timezone and missed-run behavior.
- One task owner prevents overlapping manual and scheduled work.
- Each run retains its task, input revision, result, and completed effects across interruption.
- A repeated trigger skips a completed occurrence instead of repeating its effects.
- Budget and retry limits are enforced by the runtime, not only written in a prompt.
- Pausing triggers preserves definitions and completed evidence.
- The user can invoke the same procedure manually from one prompt.

Scheduled runs grant no new permission to spend, publish, access secrets, merge, or change client scope.
Follow the current approved rules for those actions.
Use one result location and avoid duplicate reminders when state does not change.
Keep credentials, private bindings, and run state outside portable definitions.
The proposed missed-run behavior skips expired occurrences instead of starting a catch-up burst.

## Evidence

- [Workbench structure and operating rules](../../../../AGENTS.md).
- [Two-session pipeline audit](../../../../knowledge-base/evidence/2026-09-27-two-session-pipeline-audit.md).
- [Delivery retrospective](../../../../knowledge-base/wiki/domains/projects/concepts/bowerloom-delivery-retrospective.md).
- [Recorded control gaps](../../../../knowledge-base/wiki/domains/projects/concepts/sagespec-operating-improvements.md).
- Bowerloom routine contract: `code/internal-tools/bowerloom/docs/beta/routine-contracts.md` at repository commit `a9672c5`.
- Installed CLI help: `bowerloom help advanced`, read on October 12, 2026.
