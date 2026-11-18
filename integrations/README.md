# Optional transport integrations

Third-party packages that know something this plugin cannot infer — the audience
of a conversation — can declare it through the `memoryVisibility` service. None
of these patches are required: without them an undeclared session is treated as
public, which is the safe default.

## `@tencent-connect/dsh-qqbot`

`dsh-qqbot` knows whether a conversation is a one-to-one chat (`c2c`) or a group,
but does not expose that to other plugins, and its session ids are random. The
plugin can read its private preference file (`~/.dsh-qqbot/model-prefs.json`)
via `recall.visibilityBridge: true`, but that file only maps the latest session
per peer and is another plugin's private data.

`dsh-qqbot-memory-visibility.patch` adds the durable call: after a QQ session is
created, resumed, or re-forked, the transport tells this plugin the audience.

Apply it to a checkout of the QQ plugin (MIT, Copyright (c) 2026 Tencent Connect):

```bash
git clone https://github.com/tencent-connect/dsh-qqbot
cd dsh-qqbot
git apply /path/to/dsh-qqbot-memory-visibility.patch
pnpm install
pnpm build
```

Then install that build instead of the published package, and turn the bridge off
(`recall.visibilityBridge: false`, the default). The patch is a candidate pull
request: it is optional, fail-soft, and does nothing when no memory plugin is
installed.
