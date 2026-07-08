# Bundled asset pack

Assets in this directory ship inside the extension (and are therefore public
once published to the Marketplace — keep personal assets in a private pack
consumed via the `claudeCodeOrchestrator.assetPacks` setting instead).

Layout mirrors a workspace's `.claude/` directory:

```
assets/
  pack.json          # { "name": "bundled" } — pack display name
  skills/<id>/       # one directory per skill, must contain SKILL.md
  agents/<id>.md
  commands/<id>.md
  output-styles/<id>.md
```

Nothing here is installed automatically. Users pick assets per workspace via
**Manage Workspace Assets**; sync then keeps the installed copies up to date
while never overwriting files the user has edited by hand (those show as
"customized" until reset with **Reset Customized Asset to Pack Version**).
