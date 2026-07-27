<!--
SPDX-FileCopyrightText: 2024-2026 Pagefault Games

SPDX-License-Identifier: CC-BY-NC-SA-4.0
-->

<div align="center"><picture><img src="https://github.com/pagefaultgames/pokerogue-assets/blob/beta/images/logo.png?raw=true" width="300" alt="PokéRogue"></picture>

[![Discord Static Badge](https://img.shields.io/badge/Community_Discord-blurple?style=flat&logo=discord&logoSize=auto&labelColor=white&color=5865F2)](https://discord.gg/pokerogue)
[![Test Coverage Endpoint Badge](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/Bertie690/9cdfc49361824d1d5a57b7e8b38855d8/raw/coverage-badge.json)](https://github.com/pagefaultgames/pokerogue/actions/workflows/tests.yml) \
[![Docs Coverage Static Badge](https://pagefaultgames.github.io/pokerogue/beta/coverage.svg)](https://pagefaultgames.github.io/pokerogue/beta)
[![Biome Linting Static Badge](https://img.shields.io/badge/Linted_with-Biome-60a5fa?style=flat&logo=biome)](https://biomejs.dev)
[![GNU AGPLv3 License Static Badge](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
</div>

> ## ⚠️ Fork Notice — Regolo AI Battle Integration
>
> This is a fork that adds an **LLM-driven enemy AI** powered by [Regolo](https://regolo.ai) (`gpt-oss-120b`). The enemy trainer's move selection is decided by a reasoning model instead of the default heuristic, enabling more varied and strategic opponent behavior.
>
> **Configuration:** On first launch, an overlay appears asking for a Regolo API key (`sk-...`) and model. Once saved, the game auto-boots into Classic mode with an AI-picked starter. The key is stored in `localStorage` under `aiApiKey`; the model under `aiModel`. To reconfigure, clear `localStorage` or remove both keys.
>
> **Auto-boot flow (when AI is enabled):** Login → (gender auto-set, tutorial skipped) → Title → (Classic auto-selected) → Starter Select → (LLM picks starter) → EncounterPhase → battle. During battle, the LLM controls **both sides**: the enemy's moves AND the player's actions (fight/switch/catch/run).
>
> **CORS in local dev:** The Vite dev proxy forwards `/regolo-api/*` → `https://api.regolo.ai/*`, so `fetch` calls work without CORS errors. In production builds, the game calls `api.regolo.ai` directly.
>
> **Notes:**
> - Regolo API keys start with `sk-` (not `rgl-`). The overlay input placeholder reflects this.
> - **Vite version pinning matters.** This project requires Vite **8.0.16** (as locked in `pnpm-lock.yaml`). Vite **8.1.5** has a `tsconfigPaths` regression that fails to resolve `#app/*` subpath imports from files under `plugins/`, causing `Failed to resolve import "#app/global-manifest"` errors. If you see this, you likely ran `npm install` instead of `pnpm install`.
>
> **Fix:** remove npm artifacts and reinstall with pnpm:
> ```bash
> rm -rf node_modules package-lock.json
> corepack pnpm install
> corepack pnpm start:dev
> ```
>
> Don't forget to run `git submodule update --init --recursive --depth 1` before compiling it!

PokéRogue is a browser based Pokémon fangame heavily inspired by the roguelite genre. Battle endlessly while gathering stacking items, exploring many different biomes, fighting trainers, bosses, and more!

# Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md), this includes instructions on how to set up the game locally.

# 📝 Credits

> If this project contains assets you have produced and you do not see your name, **please** reach out, either [here on GitHub](https://github.com/pagefaultgames/pokerogue/issues/new) or via [Discord](https://discord.gg/pokerogue).

Thank you to all the wonderful people that have contributed to the PokéRogue project! You can find the credits [here](./CREDITS.md).

# Licensing

This repository seeks to be [REUSE compliant](https://reuse.software/): copyright and/or licensing information for each file is stored
either in the file itself or in an associated `REUSE.toml` file.

The full licensing information for each file can be found by utilizing [REUSE's tooling](https://github.com/fsfe/reuse-tool), such as via `reuse spdx`. \
An abbreviated summary of said information is as follows:
- All source code belonging to the project, unless otherwise noted, is licensed under [AGPL-v3.0-only](LICENSES/AGPL-3.0-only.txt).
- All forms of documentation (both Markdown files[^1] and any comments explicitly documenting source code) are licensed under [CC-BY-NC-SA-4.0](LICENSES/CC-BY-NC-SA-4.0.txt).
- Auto-generated files produced by external tools or files of insignificant originality are not copyrighted and are licensed under [CC0-1.0](LICENSES/CC0-1.0.txt).
- To the extent that the assets we provide are [licensable and applicable](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.en#ref-exception-or-limitation), they are licensed under [CC-BY-NC-SA-4.0](LICENSES/CC-BY-NC-SA-4.0.txt) unless otherwise noted.
  Exceptions can be found in associated `REUSE.toml` files.
  - ⚠️ Files in `assets/` that are not explicitly licensed via `REUSE.toml` files should be considered to have _no_ licensing / copyright information.

[^1]: Including this README
