<p align="center">
  <img src="docs/logo/openwa_logo.webp" alt="OpenWA-Lab Logo" width="200"/>
</p>

<h1 align="center">OpenWA-Lab</h1>
<p align="center">
  <strong>OpenWA fork — zh ↔ vi auto-translation & dashboard extensions</strong>
</p>

> **This is a fork of [rmyndharis/OpenWA](https://github.com/rmyndharis/OpenWA).**
> For the full product README, features, and releases, see the upstream project:
> [📖 Upstream README](https://github.com/rmyndharis/OpenWA/blob/main/README.md) ·
> [ℹ️ About](https://github.com/rmyndharis/OpenWA) ·
> [🏷️ Releases](https://github.com/rmyndharis/OpenWA/releases)
>
> This README documents **only the changes this fork adds on top of upstream.**

---

## What this fork adds

### zh ↔ vi auto-translation
- **Auto-translation plugin** that translates messages (Chinese ↔ Vietnamese) for selected WhatsApp groups only.
- **Translate-config management UI** plus a runtime API to enable/disable and configure translation without restarts.
- **Translate-group filter** in the chat list so translated groups are easy to find.

### Dashboard changes
- Sidebar navigation folded into **Settings**.
- **Vietnamese (vi)** language added to the dashboard i18n.
- Chat scroll fixes: scroll-restore anchored to the last-seen message, plus a **scroll-to-bottom** button.
- Appearance/language popup layout restored in the icon-row footer.

### Rename
- Project renamed **OpenWA → OpenWA-Lab** across docker/infra, swagger, package name, i18n, dashboard, and docs.

---

## Quick Start

Same as upstream — see the [upstream README](https://github.com/rmyndharis/OpenWA/blob/main/README.md) for full setup. Cloning this fork:

```bash
git clone https://github.com/JaplinChen/OpenWA-Lab.git
cd OpenWA-Lab
docker compose -f docker-compose.dev.yml up -d
# Dashboard: http://localhost:2785   API: http://localhost:2785/api   Swagger: http://localhost:2785/api/docs
```

---

## License

MIT — inherited from upstream. See [LICENSE](./LICENSE).

<div align="center">
<sub>Fork by <a href="https://github.com/JaplinChen">Japlin Chen</a> · based on <a href="https://github.com/rmyndharis/OpenWA">OpenWA</a> by <a href="https://github.com/rmyndharis">Yudhi Armyndharis</a></sub>
</div>
