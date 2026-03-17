# Demo Capture Checklist

Use this checklist for any demo-capture regression check or release proof run.

## Acceptance Bar

- One demo-required turn creates exactly one official demo run.
- Desktop chat and PWA show the same outcome for that run.
- A successful run produces one demo card sourced from the official runtime, not a recovered legacy import.
- A failed or blocked run stays inline in chat and does not open a blocking retry modal.

## Public Site Proof

Use a direct URL, not a Google search hop.

- Start a fresh demo-required turn.
- Open a stable public page directly, such as `https://www.cnn.com`.
- Capture at least two meaningful steps.
- Confirm the final demo card includes:
  - screenshots for the marked steps
  - a video without a long blank intro
  - no duplicated step sequence
  - no false `wrong_target` or `about:blank` verification failure

## Authenticated App Proof

- Use a workspace/project that already has a Maestro-managed browser profile.
- Start a fresh demo-required turn in that same workspace.
- Verify auth is reused without re-entering credentials when the session is still valid.
- Capture at least two meaningful steps in the authenticated UI.
- Confirm the final demo card is visible in:
  - desktop chat
  - PWA/mobile view

## Negative Checks

- If the agent uses a legacy helper or raw artifact path protocol on a required-demo turn, the run should fail with `legacy_protocol_rejected`.
- If the target site blocks automation, the run should surface a blocked/failed inline state rather than claiming success.
- If a run reaches `failed` or `completed`, later events must not append extra steps to that same run.

## Debug Notes

- Recovered or imported legacy artifacts are debugging evidence only. They do not satisfy a required demo run.
- If a demo card is missing, inspect the official capture run first:
  - status
  - verification status
  - failure reason
  - attached artifacts
- Treat any mismatch between desktop and PWA as a rendering/surfacing bug, not proof that capture itself failed.
