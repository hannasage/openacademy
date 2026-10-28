# Design contract

Touchline is a local curriculum tracker for an experienced engineer who learns machine learning through soccer projects.
The primary action resumes a module and saves evidence of learning.
The layout puts the next experiment first, followed by tasks, resources, and reflection.
The approved visual direction uses Projection UI and its shared typography.
Appearance uses the palette-button dropdown from hannasage.love with only two theme pairs:
- Noir Bloom (dark) / Confetti Studio (light)
- Dusk Protocol (dark) / Coastal Day (light)
Dark, Light, and System are independent of the pair. System follows device appearance live.
The default is Noir Bloom / Confetti Studio with System mode. Preferences persist per device,
independently of accounts, curricula, backups, and sync. Theme changes preserve the open lesson and edits.
Use the library palette tokens; light-mode functional accents use readable text colors.
Native iPhone/iPad use the same palette choices with native appearance controls and Dynamic Type.
The soccer theme follows the user's stated interest.
Target viewports are 1440x900 and 390x844.
All controls need visible labels, keyboard focus, and touch targets of at least 44 pixels.
Loading shows a status message. Empty progress shows the first module.
Save failures retain edits and offer retry. Partial progress shows remaining tasks.
Successful saves show a timestamp. The application requires no account or browser permissions.
