# Arena examples

These task files were used while building Warden. Their `repo` field points at a demo repository from development, so change it to a git repository on your machine before running them.

To make a small demo repo for `fix-slugify.json`:

```bash
mkdir slugify-demo && cd slugify-demo && git init
# slug.mjs with a deliberately incomplete slugify(), and test.mjs with assertions; commit both
git add -A && git commit -m init
```

Then set `"repo": "/path/to/slugify-demo"` in the task file and run:

```bash
warden arena run examples/fix-slugify.json
```

The arena shows exactly what it will run and asks before starting.
