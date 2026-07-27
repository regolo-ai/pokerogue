/*
 * AI-LLM Loader — Regolo-powered player decision provider for PokéRogue.
 *
 * Fork surface: this file + one import line in src/main.ts.
 * Patches CommandPhase.prototype.start at module load. When no key is
 * stored in localStorage, shows a DOM overlay at boot that blocks the game
 * until the user saves a key+model or skips (original UI).
 *
 * When enabled (key configured), also patches:
 * - LoginPhase.end: auto-set gender MALE, skip INTRO tutorial
 * - TitlePhase.start: auto-select Classic mode, skip title menu
 * - SelectStarterPhase.start: ask LLM to pick 3 starters, skip selection UI
 * - CommandPhase.start: ask LLM for action (fight/switch/catch/run)
 * - LearnMovePhase.replaceMoveCheck: ask LLM whether to learn new moves
 * - CheckSwitchPhase.start: auto-skip switch prompt
 * - SwitchPhase.start: auto-select first non-fainted party member on faint
 * - SelectModifierPhase.start: ask LLM to pick reward item, animate cursor
 * - MessageUiHandler.showPrompt: auto-advance prompts
 * - ConfirmUiHandler.show: auto-confirm dialogs
 * - BattleMessageUiHandler.promptLevelUpStats: auto-advance level-up screen
 *
 * The enemy uses the game's built-in AI. Only the player is LLM-controlled.
 *
 * Regolo is OpenAI-compatible: POST https://api.regolo.ai/v1/chat/completions
 * with Authorization: Bearer <key>. Model list (no auth): GET /model_group/info.
 * In dev mode, requests go through Vite's /regolo-api proxy to avoid CORS.
 */

import { getGameMode } from "#app/game-mode";
import { globalScene } from "#app/global-scene";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { PLAYER_PARTY_MAX_SIZE } from "#app/constants";
import { Tutorial } from "#app/tutorial";
import { Gender } from "#data/gender";
import { getTypeDamageMultiplier } from "#data/type";
import { Command } from "#enums/command";
import { GameModes } from "#enums/game-modes";
import { MoveCategory } from "#enums/move-category";
import { MoveId } from "#enums/move-id";
import { allMoves } from "#data/data-lists";
import { Nature } from "#enums/nature";
import { PlayerGender } from "#enums/player-gender";
import { PokeballType } from "#enums/pokeball";
import { PokemonType } from "#enums/pokemon-type";
import { SpeciesId } from "#enums/species-id";
import { Stat } from "#enums/stat";
import { StatusEffect } from "#enums/status-effect";
import { BattleType } from "#enums/battle-type";
import { BiomeId } from "#enums/biome-id";
import { CommandPhase } from "#phases/command-phase";
import { LearnMovePhase } from "#phases/learn-move-phase";
import { LoginPhase } from "#phases/login-phase";
import { CheckSwitchPhase } from "#phases/check-switch-phase";
import { SwitchPhase } from "#phases/switch-phase";
import { SwitchType } from "#enums/switch-type";
import { SelectStarterPhase } from "#phases/select-starter-phase";
import { TitlePhase } from "#phases/title-phase";
import { MessageUiHandler } from "#ui/handlers/message-ui-handler";
import { ConfirmUiHandler } from "#ui/handlers/confirm-ui-handler";
import { BattleMessageUiHandler } from "#ui/handlers/battle-message-ui-handler";
import type { ModifierSelectUiHandler } from "#ui/modifier-select-ui-handler";
import { Button } from "#enums/buttons";
import { SelectModifierPhase } from "#phases/select-modifier-phase";
import { SelectTargetPhase } from "#phases/select-target-phase";
import { UiMode } from "#enums/ui-mode";
import { PokemonModifierType, regenerateModifierPoolThresholds } from "#modifiers/modifier-type";
import { PlayerPokemon } from "#field/pokemon";
import type { Pokemon } from "#field/pokemon";
import type { Move } from "#moves/move";
import type { Starter, StarterMoveset } from "#types/save-data";
import { getPokemonSpeciesForm } from "#utils/pokemon-utils";

// ─── Config ──────────────────────────────────────────────────────────────

const LS_KEY_API = "aiApiKey";
const LS_KEY_MODEL = "aiModel";
const isDev = import.meta.env.MODE === "development";
const REGOLO_BASE = isDev ? "/regolo-api" : "https://api.regolo.ai";
const REGOLO_CHAT = `${REGOLO_BASE}/v1/chat/completions`;
const REGOLO_MODELS = `${REGOLO_BASE}/model_group/info`;
const REQUEST_TIMEOUT_MS = 120000;
const TYPE_CHART = `TYPE EFFECTIVENESS (attacking type → super effective against):
Normal: —
Fire: Grass, Ice, Bug, Steel
Water: Fire, Ground, Rock
Electric: Water, Flying
Grass: Water, Ground, Rock
Ice: Grass, Ground, Flying, Dragon
Fighting: Normal, Ice, Rock, Dark, Steel
Poison: Grass, Fairy
Ground: Fire, Electric, Poison, Rock, Steel
Flying: Electric, Grass, Fighting, Bug
Psychic: Fighting, Poison
Bug: Grass, Psychic, Dark
Rock: Fire, Ice, Flying, Bug
Ghost: Psychic, Ghost
Dragon: Dragon
Dark: Psychic, Ghost
Steel: Ice, Rock, Fairy
Fairy: Fighting, Dragon, Dark
TYPES WEAK TO (defending type ← weak to):
Normal: Fighting
Fire: Water, Ground, Rock
Water: Electric, Grass
Electric: Ground
Grass: Fire, Ice, Poison, Flying, Bug
Ice: Fire, Fighting, Rock, Steel
Fighting: Flying, Psychic, Fairy
Poison: Ground, Psychic
Ground: Water, Grass, Ice
Flying: Electric, Ice, Rock
Psychic: Bug, Ghost, Dark
Bug: Fire, Flying, Rock
Rock: Water, Grass, Fighting, Ground, Steel
Ghost: Ghost, Dark
Dragon: Ice, Dragon, Fairy
Dark: Fighting, Bug, Fairy
Steel: Fire, Fighting, Ground
Fairy: Poison, Steel`;
const STARTER_PROMPT = `You are choosing your starting Pokémon team for a Classic mode roguelite run.
Pick exactly 3 Pokémon from the list. Consider type coverage, synergy, and early-game survivability.

You MUST respond with a single valid JSON object, no other text:
{"species":["<exact name 1>","<exact name 2>","<exact name 3>"]}
Do NOT wrap the JSON in markdown code blocks. Do NOT add prose before or after. Output ONLY the raw JSON object.`;
const PLAYER_PROMPT = `You are an expert Pokémon trainer controlling your Pokémon in a roguelite game.
Each turn you decide the best action: fight (pick a move), switch to a better party member, catch the wild Pokémon, or run away.

STRATEGY — reason about types, stats, abilities, and matchup before deciding:
1. TYPE EFFECTIVENESS: Check the 'vs enemy' effectiveness shown for each move. Prefer 2x super effective moves. Avoid 0x (immune) moves. If no move is super effective, use the highest-power neutral move or switch.
2. PHYSICAL vs SPECIAL: Compare your Pokémon's effective ATK vs SPA. If ATK >> SPA, prefer Physical moves; if SPA >> ATK, prefer Special moves. Match against enemy's weaker defense (DEF vs SPD).
3. STAB: Same-type moves get a 1.5x damage bonus. Prefer STAB super-effective moves when possible.
4. ABILITY: Read enemy abilities — Levitate immune to Ground, Flash Fire immune to Fire, Wonder Guard only hit by super-effective, etc. Read your ability for synergies.
5. STATUS: Burn halves physical ATK. Paralysis quarters speed. Sleep/freeze skip turns. Poison/toxic drain HP. Factor these into damage estimates.
6. STAT STAGES: +ATK/-ATK etc. shift damage significantly. A +2 ATK Pokémon hits ~2x harder physically.
7. SPEED: Higher SPE moves first. If you outspeed and can KO, you take no damage. If you're slower and will be KO'd, switch to a tankier Pokémon.
8. HP MANAGEMENT: This is a roguelite — your party only fully heals every 10 waves. Don't sacrifice HP for a kill you don't need. Switch out a low-HP Pokémon to preserve it.

SWITCH when: your active Pokémon has a bad type matchup (0x moves or all moves not very effective), a party member has a super-effective move, or your active Pokémon's HP is below 30% and a healthier party member exists.
CATCH only wild Pokémon you don't have, with pokeballs, prefer weaker ones. You CAN catch with a full party (6) — include "releaseSlot" to release a party member and make room. Never release your active Pokémon.
RUN only from wild battles if severely outmatched and low on resources.

When switching, you MUST include both "slot" (party index) and "move" (a move the switched-in Pokémon will use next turn, from its moveset listed in YOUR PARTY).
When fighting and multiple enemies are on the field, you MUST include "targetIndex" (0-based index from ENEMY list).

${TYPE_CHART}

You MUST respond with a single valid JSON object, no other text. Use exactly one of these formats:
{"action":"fight","move":"<exact move name from AVAILABLE MOVES>","targetIndex":<0-based enemy index, only when multiple enemies>,"reasoning":"<one sentence>"}
{"action":"switch","slot":<party slot index 0-5>,"move":"<exact move name from the switched-in Pokémon's moveset>","reasoning":"<one sentence>"}
{"action":"catch","ball":<0-4>,"releaseSlot":<party slot 0-5 to release if party is full, omit if party has room>,"reasoning":"<one sentence>"}
{"action":"run","reasoning":"<one sentence>"}
Ball types: 0=Poké Ball, 1=Great Ball, 2=Ultra Ball, 3=Rogue Ball, 4=Master Ball.
Do NOT wrap the JSON in markdown code blocks. Do NOT add prose before or after. Output ONLY the raw JSON object.`;
const LEARN_MOVE_PROMPT = `You are deciding whether a Pokémon should learn a new move, replacing one of its current four moves.
Consider type coverage, move power, STAB synergy, and whether the new move offers something the current set lacks.
Respond with ONLY a raw JSON object, no markdown, no prose:
{"learn":true,"replace":<0-3>,"reasoning":"<one sentence>"}
{"learn":false,"reasoning":"<one sentence>"}
replace is the index (0-3) of the move to forget. Only use learn:false if the new move is clearly worse than all current moves.`;
const MODIFIER_PROMPT = `You are picking a reward item for your Pokémon team in a roguelite game.
Consider your party's current state (HP, levels, types) and pick the most useful item.
SURVIVAL: Your party is only fully healed every 10 waves. Prioritize:
- Healing/PP items (berries, Leftovers, Eviolite) when average HP is below 60% or you're between heal waves.
- Stat-boosting items (Zinc, Calcium, etc.) for your active Pokémon when HP is healthy.
- Type coverage TMs only if they fill a gap in your moveset.
Prefer defensive/utility items over offensive ones early in a run.

You MUST respond with a single valid JSON object, no other text:
{"index":<0-based index of the chosen item>,"reasoning":"<one sentence>"}
Do NOT wrap the JSON in markdown code blocks. Do NOT add prose before or after. Output ONLY the raw JSON object.`;

// ─── Types ──────────────────────────────────────────────────────────────

interface RegoloModel {
  model_group: string;
  mode: string;
  max_input_tokens: number | null;
  max_output_tokens: number | null;
  supports_vision: boolean | null;
  description?: string;
}

interface ChatChoice {
  message: { content: string };
}

interface ChatResponse {
  choices?: ChatChoice[];
}

// ─── State ───────────────────────────────────────────────────────────────

let apiKey: string | null = null;
let modelName: string | null = null;
let enabled = false;
let queuedMove: string | null = null;
const originalCommandStart = CommandPhase.prototype.start as (this: CommandPhase) => void;
const originalLoginEnd = LoginPhase.prototype.end as (this: LoginPhase) => Promise<void>;
const originalTitleStart = TitlePhase.prototype.start as (this: TitlePhase) => Promise<void>;
const originalStarterStart = SelectStarterPhase.prototype.start as (this: SelectStarterPhase) => void;
const originalLearnMoveStart = LearnMovePhase.prototype.start as (this: LearnMovePhase) => void;
const originalCheckSwitchStart = CheckSwitchPhase.prototype.start as (this: CheckSwitchPhase) => void;
const originalSelectModifierStart = SelectModifierPhase.prototype.start as (this: SelectModifierPhase) => false | void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const selectModifierStartAny = originalSelectModifierStart as any;

// ─── DOM overlay (boot gate) ────────────────────────────────────────────

function loadFromStorage(): void {
  apiKey = localStorage.getItem(LS_KEY_API);
  modelName = localStorage.getItem(LS_KEY_MODEL);
  enabled = !!apiKey && !!modelName;
}

async function fetchChatModels(): Promise<RegoloModel[]> {
  const res = await fetch(REGOLO_MODELS);
  if (!res.ok) {
    throw new Error(`model list HTTP ${res.status}`);
  }
  const body = (await res.json()) as { data?: RegoloModel[] };
  const all = Array.isArray(body.data) ? body.data : [];
  return all.filter(m => m.mode === "chat");
}

function showOverlay(): Promise<void> {
  return new Promise(resolve => {
    const root = document.createElement("div");
    root.id = "ai-llm-overlay";
    root.innerHTML = `
      <div class="ai-llm-card">
        <h2>PokéRogue · AI Enemy (Regolo)</h2>
        <p>Configure an OpenAI-compatible Regolo key to let an LLM drive the enemy's moves and switches. Skip to keep the original AI.</p>
        <label>API key<input type="password" id="ai-llm-key" placeholder="sk-..." autocomplete="off" /></label>
        <label>Model<select id="ai-llm-model"><option value="">Loading models…</option></select></label>
        <div class="ai-llm-row">
          <button id="ai-llm-save">Save & play</button>
          <button id="ai-llm-skip" type="button">Skip (original AI)</button>
        </div>
        <p id="ai-llm-error" class="ai-llm-err"></p>
      </div>`;
    injectStyles();
    document.body.appendChild(root);
    const keyInput = root.querySelector<HTMLInputElement>("#ai-llm-key")!;
    const modelSelect = root.querySelector<HTMLSelectElement>("#ai-llm-model")!;
    const err = root.querySelector<HTMLParagraphElement>("#ai-llm-err")!;

    if (apiKey) {
      keyInput.value = apiKey;
    }

    fetchChatModels()
      .then(models => {
        if (models.length === 0) {
          modelSelect.innerHTML = `<option value="">No chat models available</option>`;
          return;
        }
        modelSelect.innerHTML = models
          .map(
            m =>
              `<option value="${m.model_group}">${m.model_group} (in ${m.max_input_tokens ?? "?"}, out ${m.max_output_tokens ?? "?"})</option>`,
          )
          .join("");
        if (modelName) {
          modelSelect.value = modelName;
        }
      })
      .catch(e => {
        modelSelect.innerHTML = `<option value="">Failed to load models — type the model_group manually</option>`;
        console.warn("[ai-llm] model list fetch failed:", e);
      });

    const close = () => {
      root.remove();
      resolve();
    };

    root.querySelector<HTMLButtonElement>("#ai-llm-save")!.addEventListener("click", () => {
      const k = keyInput.value.trim();
      const m = modelSelect.value.trim();
      if (!k) {
        err.textContent = "Enter an API key.";
        return;
      }
      if (!m) {
        err.textContent = "Pick a model.";
        return;
      }
      localStorage.setItem(LS_KEY_API, k);
      localStorage.setItem(LS_KEY_MODEL, m);
      apiKey = k;
      modelName = m;
      enabled = true;
      close();
    });
    root.querySelector<HTMLButtonElement>("#ai-llm-skip")!.addEventListener("click", () => {
      localStorage.removeItem(LS_KEY_API);
      localStorage.removeItem(LS_KEY_MODEL);
      apiKey = null;
      modelName = null;
      enabled = false;
      close();
    });
  });
}

function injectStyles(): void {
  if (document.getElementById("ai-llm-style")) {
    return;
  }
  const style = document.createElement("style");
  style.id = "ai-llm-style";
  style.textContent = `
#ai-llm-overlay{position:fixed;inset:0;background:rgba(8,10,20,.82);display:flex;align-items:center;justify-content:center;z-index:9999;font-family:system-ui,sans-serif}
.ai-llm-card{background:#1a1d2e;color:#e8eaf2;padding:24px 28px;border-radius:14px;width:min(420px,92vw);box-shadow:0 10px 40px rgba(0,0,0,.5);border:1px solid #2d3148}
.ai-llm-card h2{margin:0 0 8px;font-size:18px;color:#ffcb05}
.ai-llm-card p{margin:0 0 16px;font-size:13px;line-height:1.45;color:#a9adbf}
.ai-llm-card label{display:block;font-size:12px;color:#a9adbf;margin-bottom:12px}
.ai-llm-card input,.ai-llm-card select{display:block;width:100%;margin-top:6px;padding:9px 10px;background:#0e1020;color:#e8eaf2;border:1px solid #2d3148;border-radius:8px;font-size:14px;box-sizing:border-box}
.ai-llm-card input:focus,.ai-llm-card select:focus{outline:none;border-color:#3b82f6}
.ai-llm-row{display:flex;gap:10px;margin-top:18px}
.ai-llm-row button{flex:1;padding:10px;border-radius:8px;border:none;font-size:14px;font-weight:600;cursor:pointer}
#ai-llm-save{background:#3b82f6;color:#fff}
#ai-llm-save:hover{background:#2563eb}
#ai-llm-skip{background:#2d3148;color:#a9adbf}
#ai-llm-skip:hover{background:#363a52}
 .ai-llm-err{color:#f87171;min-height:16px;margin-top:8px;font-size:12px}
#ai-llm-badge{position:fixed;top:10px;left:10px;z-index:9000;display:flex;align-items:center;gap:10px;padding:6px 12px;background:rgba(8,10,20,.75);border:1px solid #2d3148;border-radius:10px;font-family:system-ui,sans-serif;font-size:13px;color:#e8eaf2;backdrop-filter:blur(6px);pointer-events:none;max-width:90vw}
#ai-llm-badge img{height:24px;width:auto;display:block}
#ai-llm-badge .ai-llm-badge-name{font-weight:600;color:#ffcb05}
#ai-llm-badge .ai-llm-badge-timer{font-weight:400;color:#a9adbf;font-variant-numeric:tabular-nums;min-width:40px}
#ai-llm-party{position:fixed;top:48px;left:10px;z-index:9000;padding:8px 12px;background:rgba(8,10,20,.75);border:1px solid #2d3148;border-radius:10px;font-family:system-ui,sans-serif;font-size:12px;color:#e8eaf2;backdrop-filter:blur(6px);pointer-events:none;max-width:90vw}
#ai-llm-party .ai-llm-party-list{display:flex;flex-direction:row;gap:8px;flex-wrap:wrap;align-items:flex-start}
#ai-llm-party .ai-llm-party-row{display:flex;flex-direction:column;align-items:center;gap:2px;padding:4px 6px;border-radius:6px;min-width:68px;max-width:88px}
#ai-llm-party .ai-llm-party-row.active{background:rgba(255,203,5,.15);border:1px solid rgba(255,203,5,.4)}
#ai-llm-party .ai-llm-party-name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:76px;font-size:11px}
#ai-llm-party .ai-llm-party-level{font-size:10px;color:#a9adbf;white-space:nowrap}
#ai-llm-party .ai-llm-party-hp-bar{width:56px;height:5px;background:#1a1d2e;border-radius:3px;overflow:hidden}
#ai-llm-party .ai-llm-party-hp-bar span{display:block;height:100%;border-radius:3px}
#ai-llm-party .ai-llm-party-hp-text{font-size:10px;color:#a9adbf;white-space:nowrap;text-align:center}
#ai-llm-reasoning{position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:9000;padding:10px 24px;background:rgba(8,10,20,.9);border:1px solid #2d3148;border-radius:12px;font-family:system-ui,sans-serif;font-size:15px;color:#e8eaf2;backdrop-filter:blur(8px);pointer-events:none;max-width:80vw;text-align:center;display:none;box-shadow:0 4px 20px rgba(0,0,0,.4)}`;
  document.head.appendChild(style);
}

// ─── Persistent badge (logo + model name, top-left) ─────────────────────

const REGOLO_LOGO_URL = "https://regolo.ai/wp-content/themes/regolo/img/regolo-logo.png";

function showBadge(): void {
  if (document.getElementById("ai-llm-badge")) {
    return;
  }
  if (!enabled || !modelName) {
    return;
  }
  injectStyles();
  const badge = document.createElement("div");
  badge.id = "ai-llm-badge";
  badge.innerHTML = `<img src="${REGOLO_LOGO_URL}" alt="Regolo" onerror="this.style.display='none'"><span class="ai-llm-badge-name">${modelName}</span><span class="ai-llm-badge-timer">00:00</span>`;
  document.body.appendChild(badge);
  startBattleTimer();
}

let battleStartTime: number | null = null;
let timerInterval: ReturnType<typeof setInterval> | null = null;

function startBattleTimer(): void {
  if (timerInterval) {
    clearInterval(timerInterval);
  }
  battleStartTime = Date.now();
  updateTimerDisplay();
  timerInterval = setInterval(updateTimerDisplay, 1000);
}

function updateTimerDisplay(): void {
  const timerEl = document.getElementById("ai-llm-badge")?.querySelector(".ai-llm-badge-timer") as HTMLElement | null;
  if (!timerEl || battleStartTime === null) {
    return;
  }
  const elapsed = Math.floor((Date.now() - battleStartTime) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  timerEl.textContent = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

// ─── Party panel (live HP/level/names, top-left below badge) ──────────

let starterName: string | null = null;

function showPartyPanel(): void {
  if (document.getElementById("ai-llm-party")) {
    return;
  }
  if (!enabled) {
    return;
  }
  injectStyles();
  const panel = document.createElement("div");
  panel.id = "ai-llm-party";
  document.body.appendChild(panel);
}

function updatePartyPanel(): void {
  const panel = document.getElementById("ai-llm-party");
  if (!panel || !enabled) {
    return;
  }
  if (!globalScene?.getPlayerParty) {
    return;
  }
  const party = globalScene.getPlayerParty();
  const totalSlots = 6;
  const filled = party && party.length > 0 ? party : [];
  const rows: string[] = [];
  for (let i = 0; i < totalSlots; i++) {
    const p = filled[i];
    if (p) {
      const active = p.isActive();
      const fainted = p.isFainted();
      const maxHp = p.getMaxHp();
      const hpPct = maxHp > 0 ? Math.round((p.hp / maxHp) * 100) : 0;
      const hpColor = hpPct > 50 ? "#4ade80" : hpPct > 20 ? "#fbbf24" : "#f87171";
      const opacity = fainted ? "0.4" : "1";
      const activeClass = active ? " active" : "";
      rows.push(`<div class="ai-llm-party-row${activeClass}" style="opacity:${opacity}">
        <span class="ai-llm-party-name">${p.getName()}</span>
        <span class="ai-llm-party-level">Lv ${p.level}</span>
        <span class="ai-llm-party-hp-bar"><span style="width:${hpPct}%;background:${hpColor}"></span></span>
        <span class="ai-llm-party-hp-text">${p.hp}/${maxHp}</span>
      </div>`);
    } else {
      rows.push(`<div class="ai-llm-party-row" style="opacity:0.25">
        <span class="ai-llm-party-name">—</span>
        <span class="ai-llm-party-level">\u00a0</span>
        <span class="ai-llm-party-hp-bar"><span style="width:0%"></span></span>
        <span class="ai-llm-party-hp-text">—</span>
      </div>`);
    }
  }
  panel.innerHTML = `<div class="ai-llm-party-list">${rows.join("")}</div>`;
}

function setStarterBadge(name: string): void {
  starterName = name;
  const badge = document.getElementById("ai-llm-badge");
  if (!badge) {
    return;
  }
  const existing = badge.querySelector(".ai-llm-badge-starter");
  if (existing) {
    existing.textContent = name;
  } else {
    const span = document.createElement("span");
    span.className = "ai-llm-badge-starter";
    span.textContent = name;
    badge.appendChild(span);
  }
}

function showReasoning(text: string): void {
  let box = document.getElementById("ai-llm-reasoning");
  if (!box) {
    injectStyles();
    box = document.createElement("div");
    box.id = "ai-llm-reasoning";
    document.body.appendChild(box);
  }
  box.textContent = text;
  box.style.display = text ? "block" : "none";
}

// ─── Regolo client ──────────────────────────────────────────────────────

async function callRegolo(userPrompt: string, systemPrompt: string): Promise<string | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await callRegoloOnce(userPrompt, systemPrompt);
    if (result !== null) {
      return result;
    }
    console.warn(`[ai-llm] attempt ${attempt}/3 returned null, retrying...`);
  }
  console.warn("[ai-llm] all 3 attempts failed");
  return null;
}

async function callRegoloOnce(userPrompt: string, systemPrompt: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  console.log(`[ai-llm] callRegolo apiKey=${apiKey ? `set (${apiKey.length} chars)` : "NULL"} model=${modelName ?? "null"}`);
  try {
    const res = await fetch(REGOLO_CHAT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: modelName,
        temperature: 0.4,
        max_tokens: 15000,
        response_format: { type: "json_object" },
        reasoning_effort: "low",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!res.ok) {
      console.warn(`[ai-llm] chat HTTP ${res.status}`);
      return null;
    }
    const body = (await res.json()) as ChatResponse;
    return body.choices?.[0]?.message?.content ?? null;
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      console.warn("[ai-llm] request timed out");
    } else {
      console.warn("[ai-llm] request failed:", e);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── State serialization ───────────────────────────────────────────────

const CATEGORY_LABEL: Record<MoveCategory, string> = {
  [MoveCategory.PHYSICAL]: "Physical",
  [MoveCategory.SPECIAL]: "Special",
  [MoveCategory.STATUS]: "Status",
};

const STATUS_LABEL: Record<StatusEffect, string> = {
  [StatusEffect.NONE]: "none",
  [StatusEffect.POISON]: "poison",
  [StatusEffect.TOXIC]: "toxic",
  [StatusEffect.PARALYSIS]: "paralysis",
  [StatusEffect.SLEEP]: "sleep",
  [StatusEffect.FREEZE]: "freeze",
  [StatusEffect.BURN]: "burn",
  [StatusEffect.FAINT]: "fainted",
};

function typeName(t: PokemonType): string {
  return PokemonType[t] ?? `type${t}`;
}

function moveEffectiveness(move: any, target: Pokemon): string {
  if (move.category === MoveCategory.STATUS) {
    return "status";
  }
  const defTypes = target.getTypes();
  let multi = 1;
  for (const defType of defTypes) {
    multi *= getTypeDamageMultiplier(move.type, defType);
  }
  if (multi === 0) {
    return "0x (immune)";
  }
  if (multi >= 2) {
    return `${multi}x super effective`;
  }
  if (multi < 1) {
    return `${multi}x not very effective`;
  }
  return "1x neutral";
}

function statLine(p: Pokemon, prefix: string): string {
  const atk = p.getStatStage(Stat.ATK);
  const def = p.getStatStage(Stat.DEF);
  const spa = p.getStatStage(Stat.SPATK);
  const spd = p.getStatStage(Stat.SPDEF);
  const spe = p.getStatStage(Stat.SPD);
  const fmt = (n: number) => (n > 0 ? `+${n}` : `${n}`);
  return `${prefix} stat stages: atk ${fmt(atk)} def ${fmt(def)} spa ${fmt(spa)} spd ${fmt(spd)} spe ${fmt(spe)}`;
}

function pokemonLine(p: Pokemon, label: string): string {
  const name = p.getName();
  const types = p
    .getTypes()
    .map(t => typeName(t))
    .join("/");
  const status = STATUS_LABEL[p.status?.effect ?? StatusEffect.NONE];
  const hp = `${p.hp}/${p.getMaxHp()} (${Math.round((p.hp / p.getMaxHp()) * 100)}%)`;
  const stats = p.getStats();
  const baseStats = p.getSpeciesForm().baseStats;
  const statsLine = `base HP ${baseStats[Stat.HP]} ATK ${baseStats[Stat.ATK]} DEF ${baseStats[Stat.DEF]} SPA ${baseStats[Stat.SPATK]} SPD ${baseStats[Stat.SPDEF]} SPE ${baseStats[Stat.SPD]} | effective ATK ${stats[Stat.ATK]} DEF ${stats[Stat.DEF]} SPA ${stats[Stat.SPATK]} SPD ${stats[Stat.SPDEF]} SPE ${stats[Stat.SPD]}`;
  return `${label}: ${name} Lv ${p.level}, types ${types}, HP ${hp}, ability ${p.getAbility().name}, status ${status}\n  ${statsLine}`;
}


// ─── Starter selection ─────────────────────────────────────────────────

function buildStarter(speciesId: SpeciesId): Starter {
  const startingLevel = getGameMode(GameModes.CLASSIC).getStartingLevel();
  const speciesForm = getPokemonSpeciesForm(speciesId, 0);
  const species = speciesDataRegistry.getSpecies(speciesForm.speciesId);
  const pokemon = new PlayerPokemon(species, startingLevel, undefined, 0);
  const levelMoves = species.getLevelMoves();
  const starterMoveIds = levelMoves
    .filter(lm => lm[0] > 0 && lm[0] <= 5)
    .map(lm => lm[1])
    .slice(0, 4) as StarterMoveset;
  return {
    speciesId,
    shiny: pokemon.shiny,
    variant: pokemon.variant,
    formIndex: pokemon.formIndex,
    ivs: pokemon.ivs,
    abilityIndex: pokemon.abilityIndex,
    passive: false,
    nature: pokemon.getNature(),
    pokerus: pokemon.pokerus,
    moveset: starterMoveIds,
  };
}

function pickRandomSpeciesIds(count: number): SpeciesId[] {
  const all = speciesDataRegistry.getAllStarters();
  const shuffled = [...all].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

function parseStarter(content: string | null, options: SpeciesId[]): SpeciesId[] | null {
  if (!content) {
    return null;
  }
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }
  let parsed: { species?: string | string[] } | null = null;
  try {
    parsed = JSON.parse(jsonMatch[0]) as { species?: string | string[] };
  } catch {
    return null;
  }
  const names = Array.isArray(parsed?.species)
    ? parsed!.species.map(s => s.trim().toLowerCase())
    : parsed?.species
      ? [parsed.species.trim().toLowerCase()]
      : [];
  if (names.length === 0) {
    return null;
  }
  const result: SpeciesId[] = [];
  for (const name of names) {
    for (const id of options) {
      const species = speciesDataRegistry.getSpecies(id);
      if (species.name.toLowerCase() === name && !result.includes(id)) {
        result.push(id);
        break;
      }
    }
  }
  return result.length > 0 ? result : null;
}

// ─── Phase patches ────────────────────────────────────────────────────────

// ─── Player-side AI (CommandPhase) ───────────────────────────────────────

const POKEBALL_NAMES = ["Poké Ball", "Great Ball", "Ultra Ball", "Rogue Ball", "Master Ball"];

function serializePlayerState(phase: CommandPhase): string {
  const lines: string[] = [];
  const playerPokemon = phase.getPokemon();
  const battle = globalScene.currentBattle;
  const isTrainer = battle.battleType === BattleType.TRAINER;
  const enemyField = globalScene.getEnemyField();

  lines.push("=== YOUR ACTIVE POKÉMON ===");
  lines.push(pokemonLine(playerPokemon, "ACTIVE"));
  lines.push(statLine(playerPokemon, "ACTIVE"));

  const moveset = playerPokemon.getMoveset().filter(m => m.isUsable(playerPokemon, false, true)[0]);
  if (moveset.length === 0) {
    lines.push('AVAILABLE MOVES (pick one, exact name required):');
    lines.push('  1. "Struggle" — Normal Physical, power 50, acc —, type NORMAL');
  } else {
    lines.push("AVAILABLE MOVES (pick one, exact name required):");
    const enemyField = globalScene.getEnemyField().filter(p => p.isActive(true));
    moveset.forEach((pm, i) => {
      const move = pm.getMove();
      const stab = playerPokemon.getTypes().includes(move.type) ? ", STAB" : "";
      const acc = move.accuracy >= 0 ? `${move.accuracy}%` : "—";
      const engName = MoveId[move.id];
      const effVs = enemyField.length > 0
        ? ` | vs enemy: ${moveEffectiveness(move, enemyField[0])}${enemyField.length > 1 ? `, vs enemy 2: ${moveEffectiveness(move, enemyField[1])}` : ""}`
        : "";
      lines.push(
        `  ${i + 1}. "${move.name}" (${engName}) — ${typeName(move.type)} ${CATEGORY_LABEL[move.category]}, power ${move.power}, acc ${acc}, PP ${pm.getMovePp() - pm.ppUsed}/${pm.getMovePp()}${stab}${effVs}`,
      );
    });
  }

  lines.push("=== YOUR PARTY ===");
  globalScene.getPlayerParty().forEach((p, i) => {
    const active = p.isActive() ? " (ACTIVE)" : "";
    const hp = `${p.hp}/${p.getMaxHp()} (${Math.round((p.hp / p.getMaxHp()) * 100)}%)`;
    const types = p.getTypes().map(t => typeName(t)).join("/");
    const baseStats = p.getSpeciesForm().baseStats;
    const statsInfo = `base ATK ${baseStats[Stat.ATK]} DEF ${baseStats[Stat.DEF]} SPA ${baseStats[Stat.SPATK]} SPD ${baseStats[Stat.SPDEF]} SPE ${baseStats[Stat.SPD]}`;
    const movesList = p.getMoveset().map(pm => {
      const mv = pm.getMove();
      const pp = pm.getMovePp() - pm.ppUsed;
      return `${mv.name} (${MoveId[mv.id]}, ${typeName(mv.type)}, pow ${mv.power}, PP ${pp})`;
    }).join(", ");
    lines.push(`  [${i}] ${p.getName()} Lv ${p.level}, types ${types}, HP ${hp}${active}, ${statsInfo}, moves: ${movesList || "none"}`);
  });

  lines.push("=== ENEMY ===");
  enemyField.forEach((e, i) => {
    lines.push(pokemonLine(e, `ENEMY ${i + 1}`));
    lines.push(statLine(e, `ENEMY ${i + 1}`));
  });

  const weather = globalScene.arena.weather;
  const terrain = globalScene.arena.terrain;
  const field: string[] = [];
  if (weather && weather.weatherType) {
    field.push(`weather ${weather.weatherType}`);
  }
  if (terrain && terrain.terrainType) {
    field.push(`terrain ${terrain.terrainType}`);
  }
  if (field.length) {
    lines.push(`FIELD: ${field.join(", ")}`);
  }

  lines.push(`BATTLE TYPE: ${isTrainer ? "trainer (cannot catch, cannot run)" : "wild (can catch, can run)"}`);
  lines.push(`WAVE: ${battle.waveIndex}`);

  const balls: string[] = [];
  for (let b = 0; b < POKEBALL_NAMES.length; b++) {
    const count = globalScene.pokeballCounts[b as PokeballType] ?? 0;
    if (count > 0) {
      balls.push(`${b}=${POKEBALL_NAMES[b]} (${count} left)`);
    }
  }
  if (balls.length > 0) {
    lines.push(`AVAILABLE BALLS: ${balls.join(", ")}`);
  } else {
    lines.push("AVAILABLE BALLS: none");
  }

  lines.push("=== VALID ACTIONS ===");
  lines.push("- fight: pick a move from AVAILABLE MOVES (use the exact move name)");
  const switchable = globalScene.getPlayerParty().filter((p, i) => i !== phase.getFieldIndex() && !p.isFainted());
  const switchList = switchable.map(p => {
    const idx = globalScene.getPlayerParty().indexOf(p);
    return `[${idx}] ${p.getName()}`;
  }).join(", ");
  lines.push(`- switch: {"action":"switch","slot":<index>,"move":"<move name>"} — switch to slot index from YOUR PARTY (switchable: ${switchList || "none"}). MUST include "move" = a move from the switched-in Pokémon's moveset.`);
  const isDouble = globalScene.currentBattle.double;
  const partyFull = globalScene.getPlayerParty().length >= PLAYER_PARTY_MAX_SIZE;
  if (!isTrainer && balls.length > 0 && !isDouble) {
    if (partyFull) {
      lines.push("- catch: ball index from AVAILABLE BALLS — party is full, MUST include releaseSlot (0-5, never your active slot) to release a party member and make room");
    } else {
      lines.push("- catch: ball index from AVAILABLE BALLS (only on wild Pokémon, not in double battles)");
    }
  }
  if (!isTrainer && globalScene.arena.biomeId !== BiomeId.END) {
    lines.push("- run: flee (risky, may fail)");
  }

  return lines.join("\n");
}

interface PlayerDecision {
  action: "fight" | "switch" | "catch" | "run";
  move?: string;
  slot?: number;
  ball?: number;
  targetIndex?: number;
  releaseSlot?: number;
  reasoning?: string;
}

function parsePlayerDecision(content: string | null, phase: CommandPhase): PlayerDecision | null {
  if (!content) {
    return null;
  }
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }
  let parsed: PlayerDecision | null = null;
  try {
    parsed = JSON.parse(jsonMatch[0]) as PlayerDecision;
  } catch {
    return null;
  }
  if (!parsed || !parsed.action) {
    return null;
  }

  const playerPokemon = phase.getPokemon();

  if (parsed.action === "fight") {
    const moveName = parsed.move?.trim();
    if (!moveName) {
      return null;
    }
    if (moveName.toLowerCase() === "struggle") {
      return parsed;
    }
    const usable = playerPokemon.getMoveset().filter(m => m.isUsable(playerPokemon, false, true)[0]);
    const lower = moveName.toLowerCase();
    for (const pm of usable) {
      const move = pm.getMove();
      if (move.name.toLowerCase() === lower || MoveId[move.id].toLowerCase() === lower) {
        return parsed;
      }
    }
    const idx = parseInt(moveName, 10);
    if (!isNaN(idx) && idx >= 1 && idx <= usable.length) {
      return parsed;
    }
    return null;
  }

  if (parsed.action === "switch") {
    const party = globalScene.getPlayerParty();
    let slot = parsed.slot;
    if (typeof slot !== "number") {
      const nameMatch = (parsed as any).name || (parsed as any).pokemon;
      if (typeof nameMatch === "string") {
        const lower = nameMatch.toLowerCase();
        slot = party.findIndex(p => p.getName().toLowerCase() === lower);
      }
    }
    if (typeof slot !== "number" || slot < 0 || slot >= party.length) {
      return null;
    }
    if (slot === phase.getFieldIndex()) {
      return null;
    }
    if (party[slot]?.isFainted()) {
      return null;
    }
    parsed.slot = slot;
    return parsed;
  }

  if (parsed.action === "catch") {
    if (globalScene.currentBattle.battleType === BattleType.TRAINER) {
      return null;
    }
    if (globalScene.currentBattle.double) {
      return null;
    }
    const partyFull = globalScene.getPlayerParty().length >= PLAYER_PARTY_MAX_SIZE;
    if (partyFull) {
      // Party full — require a valid releaseSlot that is not the active Pokémon
      const releaseSlot = (parsed as any).releaseSlot;
      const party = globalScene.getPlayerParty();
      const activeIdx = phase.getFieldIndex();
      if (typeof releaseSlot !== "number" || releaseSlot < 0 || releaseSlot >= party.length || releaseSlot === activeIdx) {
        return null;
      }
      parsed.releaseSlot = releaseSlot;
    }
    const ball = parsed.ball;
    if (typeof ball !== "number" || ball < 0 || ball >= POKEBALL_NAMES.length) {
      const ballName = (parsed as any).ballName;
      if (typeof ballName === "string") {
        const idx = POKEBALL_NAMES.findIndex(n => n.toLowerCase() === ballName.toLowerCase());
        if (idx >= 0 && (globalScene.pokeballCounts[idx as PokeballType] ?? 0) > 0) {
          parsed.ball = idx;
          return parsed;
        }
      }
      return null;
    }
    if ((globalScene.pokeballCounts[ball as PokeballType] ?? 0) <= 0) {
      return null;
    }
    return parsed;
  }

  if (parsed.action === "run") {
    if (globalScene.currentBattle.battleType === BattleType.TRAINER) {
      return null;
    }
    if (globalScene.arena.biomeId === BiomeId.END) {
      return null;
    }
    return parsed;
  }

  return null;
}

function installCommandPatch(): void {
  CommandPhase.prototype.start = function start(this: CommandPhase): void {
    if (!enabled) {
      return originalCommandStart.call(this);
    }
    if (globalScene.currentBattle.turnCommands[this.fieldIndex]?.skip) {
      return originalCommandStart.call(this);
    }
    void llmPlayerFlow(this);
  } as (this: CommandPhase) => void;
}

async function llmPlayerFlow(phase: CommandPhase): Promise<void> {
  try {
    // Fast path: if we have a queued move from a previous switch decision, use it directly
    if (queuedMove) {
      const moveName = queuedMove;
      queuedMove = null;
      const playerPokemon = phase.getPokemon();
      const usable = playerPokemon.getMoveset().filter(m => m.isUsable(playerPokemon, false, true)[0]);
      let cursor = usable.findIndex(pm => pm.getMove().name.toLowerCase() === moveName.toLowerCase());
      if (cursor < 0) {
        cursor = usable.findIndex(pm => MoveId[pm.getMove().id].toLowerCase() === moveName.toLowerCase());
      }
      if (cursor >= 0) {
        console.log(`[ai-llm] using queued move: ${moveName} (skipping API call)`);
        showReasoning(`AI: queued move ${moveName}`);
        const success = phase.handleCommand(Command.FIGHT, cursor);
        if (success) {
          updatePartyPanel();
          return;
        }
      } else {
        console.warn(`[ai-llm] queued move ${moveName} not usable, falling back to API`);
      }
    }

    const prompt = serializePlayerState(phase);

    globalScene.ui.showText(`${modelName} is thinking the next move...`);
    updatePartyPanel();

    let decision: PlayerDecision | null = null;
    for (let attempt = 1; attempt <= 3 && decision === null; attempt++) {
      const content = await callRegolo(prompt, PLAYER_PROMPT);
      decision = parsePlayerDecision(content, phase);
      if (decision === null) {
        console.warn(`[ai-llm] player attempt ${attempt}/3 returned invalid decision, retrying...`);
      }
    }

    if (decision === null) {
      console.warn("[ai-llm] player LLM failed after 3 attempts, using first usable move");
      showReasoning("AI: all attempts failed, using first usable move");
      const pkm = phase.getPokemon();
      const usableFallback = pkm.getMoveset().filter(m => m.isUsable(pkm, false, true)[0]);
      if (usableFallback.length > 0) {
        phase.handleCommand(Command.FIGHT, 0);
      } else {
        const allMoves = pkm.getMoveset();
        phase.handleCommand(Command.FIGHT, allMoves.length > 0 ? 0 : -1);
      }
      updatePartyPanel();
      return;
    }

    console.log(`[ai-llm] player decision: ${decision.action} — ${decision.reasoning ?? ""}`);
    showReasoning(`AI: ${decision.reasoning ?? ""}`);

    let success = false;
    if (decision.action === "fight") {
      const playerPokemon = phase.getPokemon();
      const usable = playerPokemon.getMoveset().filter(m => m.isUsable(playerPokemon, false, true)[0]);
      let cursor: number;
      const moveName = (decision.move ?? "").trim().toLowerCase();
      console.log(`[ai-llm] fight: move="${decision.move}" usable=${usable.length} allMoves=${playerPokemon.getMoveset().length}`);
      if (moveName === "struggle" || moveName === "") {
        if (usable.length > 0) {
          if (moveName === "struggle") {
            console.warn(`[ai-llm] AI picked Struggle but ${usable.length} moves are usable, using first usable`);
          }
          cursor = 0;
        } else {
          const allMoves = playerPokemon.getMoveset();
          cursor = allMoves.length > 0 ? 0 : -1;
        }
      } else {
        cursor = usable.findIndex(pm => {
          const mv = pm.getMove();
          return mv.name.toLowerCase() === moveName || MoveId[mv.id].toLowerCase() === moveName;
        });
        if (cursor < 0) {
          const idx = parseInt(moveName, 10);
          if (!isNaN(idx) && idx >= 1 && idx <= usable.length) {
            cursor = idx - 1;
          }
        }
        if (cursor < 0 && usable.length > 0) {
          console.warn(`[ai-llm] move "${decision.move}" not found in usable, using first usable move`);
          cursor = 0;
        }
        if (cursor < 0) {
          const allMoves = playerPokemon.getMoveset();
          cursor = allMoves.length > 0 ? 0 : -1;
        }
      }
      console.log(`[ai-llm] fight cursor=${cursor}, calling handleCommand`);
      success = phase.handleCommand(Command.FIGHT, cursor);
      console.log(`[ai-llm] fight handleCommand result=${success}`);
      // If AI specified a target and multiple enemies exist, set it directly to skip SelectTargetPhase
      if (success && typeof decision.targetIndex === "number") {
        const enemyField = globalScene.getEnemyField().filter(p => p.isActive(true));
        console.log(`[ai-llm] target check: targetIndex=${decision.targetIndex}, enemyField.length=${enemyField.length}`);
        if (decision.targetIndex >= 0 && decision.targetIndex < enemyField.length) {
          const turnCommand = globalScene.currentBattle.turnCommands[phase.getFieldIndex()];
          console.log(`[ai-llm] turnCommand=${turnCommand ? "set" : "null"}, move=${turnCommand?.move ? "set" : "null"}`);
          if (turnCommand?.move) {
            turnCommand.move.targets = [enemyField[decision.targetIndex].getBattlerIndex()];
            console.log(`[ai-llm] target pre-selected: ${enemyField[decision.targetIndex].getName()} (index ${decision.targetIndex})`);
          }
        }
      } else {
        console.log(`[ai-llm] target skip: success=${success}, hasTargetIndex=${typeof decision.targetIndex === "number"}`);
      }
    } else if (decision.action === "switch") {
      success = phase.handleCommand(Command.POKEMON, decision.slot!, false);
      if (success && decision.move) {
        queuedMove = decision.move;
      }
    } else if (decision.action === "catch") {
      // If party is full, pre-release the chosen slot so the original catch flow goes straight to addToParty()
      if (typeof decision.releaseSlot === "number" && globalScene.getPlayerParty().length >= PLAYER_PARTY_MAX_SIZE) {
        const party = globalScene.getPlayerParty();
        const releaseSlot = decision.releaseSlot;
        const activeIdx = phase.getFieldIndex();
        if (releaseSlot >= 0 && releaseSlot < party.length && releaseSlot !== activeIdx) {
          const released = party[releaseSlot];
          console.log(`[ai-llm] pre-releasing slot ${releaseSlot} (${released.getName()}) to make room for catch`);
          globalScene.removePartyMemberModifiers(releaseSlot);
          party.splice(releaseSlot, 1)[0].destroy();
          globalScene.updateModifiers(true);
          showReasoning(`Released ${released.getName()} to make room`);
        }
      }
      success = phase.handleCommand(Command.BALL, decision.ball!);
    } else if (decision.action === "run") {
      success = phase.handleCommand(Command.RUN, 0);
    }
    if (!success) {
      console.warn(`[ai-llm] ${decision.action} command failed, using first usable move`);
      const pkm = phase.getPokemon();
      const usableFallback = pkm.getMoveset().filter(m => m.isUsable(pkm, false, true)[0]);
      if (usableFallback.length > 0) {
        success = phase.handleCommand(Command.FIGHT, 0);
      } else {
        const allMoves = pkm.getMoveset();
        success = phase.handleCommand(Command.FIGHT, allMoves.length > 0 ? 0 : -1);
      }
    }
    if (!success) {
      console.warn(`[ai-llm] all fallbacks failed, forcing phase end`);
      phase.end();
    }
    updatePartyPanel();
  } catch (e) {
    console.warn("[ai-llm] player flow error, forcing fight:", e);
    try {
      const pkm = phase.getPokemon();
      const usableFallback = pkm.getMoveset().filter(m => m.isUsable(pkm, false, true)[0]);
      if (usableFallback.length > 0) {
        phase.handleCommand(Command.FIGHT, 0);
      } else {
        const allMoves = pkm.getMoveset();
        phase.handleCommand(Command.FIGHT, allMoves.length > 0 ? 0 : -1);
      }
    } catch {
      phase.end();
    }
  }
}

function installLoginPatch(): void {
  LoginPhase.prototype.end = async function end(this: LoginPhase): Promise<void> {
    if (enabled) {
      globalScene.gameData.gender = PlayerGender.MALE;
      globalScene.gameData.saveTutorialFlag(Tutorial.INTRO, true);
      globalScene.enableTutorials = false;
    }
    return originalLoginEnd.call(this);
  } as (this: LoginPhase) => Promise<void>;
}

function installTitlePatch(): void {
  TitlePhase.prototype.start = async function start(this: TitlePhase): Promise<void> {
    if (enabled) {
      globalScene.ui.clearText();
      this.gameMode = GameModes.CLASSIC;
      this.end();
      return;
    }
    return originalTitleStart.call(this);
  } as (this: TitlePhase) => Promise<void>;
}

function installStarterPatch(): void {
  SelectStarterPhase.prototype.start = function start(this: SelectStarterPhase): void {
    if (!enabled) {
      return originalStarterStart.call(this);
    }
    void llmStarterFlow(this);
  } as (this: SelectStarterPhase) => void;
}

async function llmStarterFlow(phase: SelectStarterPhase): Promise<void> {
  try {
    const candidates = pickRandomSpeciesIds(6);
    const names = candidates.map(id => speciesDataRegistry.getSpecies(id).name);
    const prompt = `Available starters (pick exactly 3, exact names required):\n${names.map((n, i) => `  ${i + 1}. ${n}`).join("\n")}`;

    globalScene.ui.showText(`AI is choosing starters...\nCandidates: ${names.join(", ")}`);

    const content = await callRegolo(prompt, STARTER_PROMPT);
    const speciesIds = parseStarter(content, candidates);

    if (speciesIds === null || speciesIds.length === 0) {
      console.warn("[ai-llm] starter selection failed, picking 3 random");
      const shuffled = [...candidates].sort(() => Math.random() - 0.5);
      const fallbackIds = shuffled.slice(0, 3);
      const starters = fallbackIds.map(id => buildStarter(id));
      globalScene.sessionSlotId = 0;
      phase.initBattle(starters);
      return;
    }

    const pickedNames = speciesIds.map(id => speciesDataRegistry.getSpecies(id).name);
    console.log(`[ai-llm] AI picked starters: ${pickedNames.join(", ")}`);
    const starters = speciesIds.map(id => buildStarter(id));
    globalScene.sessionSlotId = 0;
    phase.initBattle(starters);
    updatePartyPanel();
  } catch (e) {
    console.warn("[ai-llm] starter flow error, falling back to UI:", e);
    return originalStarterStart.call(phase);
  }
}

// ─── Learn-move AI ─────────────────────────────────────────────────────

function installLearnMovePatch(): void {
  (LearnMovePhase.prototype as unknown as { replaceMoveCheck: (this: LearnMovePhase, move: Move, pokemon: Pokemon) => Promise<void> }).replaceMoveCheck = async function replaceMoveCheck(this: LearnMovePhase, move: Move, pokemon: Pokemon): Promise<void> {
    if (!enabled) {
      return originalReplaceMoveCheck.call(this, move, pokemon);
    }
    void llmLearnMoveFlow(this, move, pokemon);
  };
}

const originalReplaceMoveCheck = (LearnMovePhase.prototype as unknown as { replaceMoveCheck: (this: LearnMovePhase, move: Move, pokemon: Pokemon) => Promise<void> }).replaceMoveCheck;

async function llmLearnMoveFlow(phase: LearnMovePhase, move: Move, pokemon: Pokemon): Promise<void> {
  try {
    const lines: string[] = [];
    lines.push(`Pokémon: ${pokemon.getName()} Lv ${pokemon.level}, types ${pokemon.getTypes().map(t => typeName(t)).join("/")}`);
    lines.push("CURRENT MOVESET:");
    const moveset = pokemon.getMoveset();
    moveset.forEach((pm, i) => {
      const m = pm.getMove();
      const acc = m.accuracy >= 0 ? `${m.accuracy}%` : "—";
      lines.push(`  [${i}] "${m.name}" — ${typeName(m.type)} ${CATEGORY_LABEL[m.category]}, power ${m.power}, acc ${acc}, PP ${pm.getMovePp() - pm.ppUsed}/${pm.getMovePp()}`);
    });
    lines.push("NEW MOVE TO LEARN:");
    const acc = move.accuracy >= 0 ? `${move.accuracy}%` : "—";
    lines.push(`  "${move.name}" — ${typeName(move.type)} ${CATEGORY_LABEL[move.category]}, power ${move.power}, acc ${acc}`);

    const prompt = lines.join("\n");

    globalScene.ui.showText(`AI is deciding whether to learn ${move.name}...`);

    const content = await callRegolo(prompt, LEARN_MOVE_PROMPT);

    if (!content) {
      console.warn("[ai-llm] learn-move LLM failed, skipping");
      phase.end();
      return;
    }

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[ai-llm] learn-move invalid JSON, skipping");
      phase.end();
      return;
    }

    let decision: { learn?: boolean; replace?: number; reasoning?: string };
    try {
      decision = JSON.parse(jsonMatch[0]) as { learn?: boolean; replace?: number; reasoning?: string };
    } catch {
      console.warn("[ai-llm] learn-move JSON parse failed, skipping");
      phase.end();
      return;
    }

    if (decision.reasoning) {
      showReasoning(`Learn ${move.name}: ${decision.reasoning}`);
    }

    if (decision.learn && typeof decision.replace === "number" && decision.replace >= 0 && decision.replace < moveset.length) {
      console.log(`[ai-llm] AI learning ${move.name}, replacing ${moveset[decision.replace].getMove().name}`);
      (phase as unknown as { learnMove: (index: number, move: Move, pokemon: Pokemon) => void }).learnMove(decision.replace, move, pokemon);
    } else {
      console.log(`[ai-llm] AI skipping ${move.name}`);
      phase.end();
    }
  } catch (e) {
    console.warn("[ai-llm] learn-move flow error, skipping:", e);
    phase.end();
  }
}

// ─── Boot ────────────────────────────────────────────────────────────────

function installSelectModifierPatch(): void {
  (SelectModifierPhase.prototype as any).start = function start(this: SelectModifierPhase): void {
    if (!enabled) {
      return selectModifierStartAny.call(this);
    }
    void llmModifierFlow(this);
  };
}

async function llmModifierFlow(phase: SelectModifierPhase): Promise<void> {
  try {
    if (!phase.isPlayer()) {
      return selectModifierStartAny.call(phase);
    }

    // Run the original start() to show the modifier select UI with its callback
    selectModifierStartAny.call(phase);

    const party = globalScene.getPlayerParty();
    const typeOptions: any[] = (phase as any).typeOptions;
    if (!typeOptions || typeOptions.length === 0) {
      return;
    }

    // Build prompt while the pokeball reveal animation plays
    const lines: string[] = [];
    lines.push("=== YOUR PARTY ===");
    party.forEach((p, i) => {
      const maxHp = p.getMaxHp();
      const hpPct = maxHp > 0 ? Math.round((p.hp / maxHp) * 100) : 0;
      const moves = p.getMoveset().map((m: any) => m.getMove().name).join(", ");
      lines.push(`  [${i}] ${p.getName()} Lv ${p.level}, HP ${p.hp}/${maxHp} (${hpPct}%), types ${p.getTypes().map((t: any) => typeName(t)).join("/")}, moves: ${moves}`);
    });
    lines.push(`MONEY: ${globalScene.money}`);
    lines.push(`WAVE: ${globalScene.currentBattle.waveIndex}`);
    lines.push("=== AVAILABLE ITEMS (pick one by index) ===");
    typeOptions.forEach((opt, i) => {
      const t = opt.type;
      let name = "";
      let desc = "";
      try { name = t.name; } catch { name = "unknown"; }
      try { desc = t.getDescription(); } catch { desc = ""; }
      const needsTarget = t instanceof PokemonModifierType;
      const note = needsTarget ? " [requires targetSlot 0-5]" : "";
      lines.push(`  [${i}] ${name} — ${desc}${note}`);
    });
    lines.push("");
    lines.push('Reply with JSON: {"index": <item index>, "targetSlot": <party slot 0-5, required for items targeting a Pokémon>, "reasoning": "<short reason>"}');

    const prompt = lines.join("\n");

    showReasoning(`${modelName} is choosing an item...`);
    updatePartyPanel();

    // Start LLM call concurrently with the pokeball animation
    const contentPromise = callRegolo(prompt, MODIFIER_PROMPT);

    // Wait for the pokeball animation to finish (awaitingActionInput becomes true)
    const ready = await waitForModifierReady();
    if (!ready) {
      console.warn("[ai-llm] modifier UI not ready in time, skipping");
      globalScene.ui.setMode(UiMode.MESSAGE).then(() => (phase as any).end());
      return;
    }

    const content = await contentPromise;

    let choiceIndex = -1;
    let targetSlot = -1;
    if (content) {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]) as { index?: number; targetSlot?: number; reasoning?: string };
          if (typeof parsed.index === "number" && parsed.index >= 0 && parsed.index < typeOptions.length) {
            choiceIndex = parsed.index;
            if (typeof parsed.targetSlot === "number" && parsed.targetSlot >= 0 && parsed.targetSlot < party.length) {
              targetSlot = parsed.targetSlot;
            }
            if (parsed.reasoning) {
              showReasoning(`Item: ${parsed.reasoning}`);
            }
          }
        } catch { /* ignore */ }
      }
    }

    if (choiceIndex < 0) {
      console.warn("[ai-llm] modifier selection failed, skipping");
      globalScene.ui.setMode(UiMode.MESSAGE).then(() => (phase as any).end());
      return;
    }

    const modifierType = typeOptions[choiceIndex].type;
    const needsTarget = modifierType instanceof PokemonModifierType;
    if (needsTarget && (targetSlot < 0 || targetSlot >= party.length)) {
      targetSlot = 0;
    }
    console.log(`[ai-llm] AI picked item index ${choiceIndex}: ${modifierType.name}${needsTarget ? ` (→ slot ${targetSlot})` : ""}`);

    if (needsTarget) {
      // Bypass the UI entirely — the party menu callback re-shows the modifier UI
      // (setMode(MODIFIER_SELECT)) which starts a new pokeball animation that leaves
      // visual artifacts when immediately cleared. Create the modifier directly.
      try {
        const modifier = modifierType.newModifier(party[targetSlot]);
        if (modifier) {
          (phase as any).applyModifier(modifier, -1, false);
        } else {
          globalScene.ui.setMode(UiMode.MESSAGE).then(() => (phase as any).end());
        }
      } catch {
        globalScene.ui.setMode(UiMode.MESSAGE).then(() => (phase as any).end());
      }
    } else {
      // Non-target item: move cursor for visual feedback, then press ACTION.
      // The original callback handles applyModifier → setMode(MESSAGE) → end.
      await animateModifierCursor(choiceIndex);
      const handler = globalScene.ui.getHandler() as ModifierSelectUiHandler;
      handler.processInput(Button.ACTION);
    }
    updatePartyPanel();
  } catch (e) {
    console.warn("[ai-llm] modifier flow error, falling back to UI:", e);
    return selectModifierStartAny.call(phase);
  }
}

async function waitForModifierReady(maxWaitMs = 10000): Promise<boolean> {
  for (let i = 0; i < maxWaitMs / 100; i++) {
    const handler = globalScene.ui.getHandler();
    if (handler && (handler as any).awaitingActionInput === true) {
      return true;
    }
    await sleep(100);
  }
  return false;
}

async function animateModifierCursor(choiceIndex: number): Promise<void> {
  const handler = globalScene.ui.getHandler() as ModifierSelectUiHandler;
  if (!handler || typeof handler.setRowCursor !== "function") {
    return;
  }
  // Move to the rewards row (rowCursor = 1) and set cursor directly to choiceIndex
  handler.setRowCursor(1);
  await sleep(100);
  handler.setCursor(choiceIndex);
  await sleep(800);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => globalScene.time.delayedCall(ms, resolve));
}
function installCheckSwitchPatch(): void {
  CheckSwitchPhase.prototype.start = function start(this: CheckSwitchPhase): void {
    if (enabled) {
      this.end();
      return;
    }
    return originalCheckSwitchStart.call(this);
  } as (this: CheckSwitchPhase) => void;
}

const originalSwitchStart = SwitchPhase.prototype.start as (this: SwitchPhase) => void;

function installSwitchPatch(): void {
  SwitchPhase.prototype.start = function start(this: SwitchPhase): void {
    if (!enabled) {
      return originalSwitchStart.call(this);
    }
    // Skip the UI party menu and auto-select the first non-fainted, non-on-field party member
    const party = globalScene.getPlayerParty();
    const battlerCount = globalScene.currentBattle.getBattlerCount();
    const allowed = globalScene.getPokemonAllowedInBattle();
    const fieldIndex = globalScene.currentBattle.getBattlerCount() === 1 || allowed.length > 1
      ? (this as any).fieldIndex
      : 0;
    const candidate = party.find((p, i) => i >= battlerCount && i < 6 && !p.isFainted() && !p.isOnField());
    if (candidate) {
      const slotIndex = party.indexOf(candidate);
      const switchType = (this as any).switchType as SwitchType;
      const doReturn = (this as any).doReturn as boolean;
      globalScene.phaseManager.unshiftNew("SwitchSummonPhase", switchType, fieldIndex, slotIndex, doReturn);
    }
    globalScene.ui.setMode(UiMode.MESSAGE).then(() => (this as any).end());
  } as (this: SwitchPhase) => void;
}

const originalSelectTargetStart = SelectTargetPhase.prototype.start as (this: SelectTargetPhase) => void;

const TARGET_PROMPT = `You are choosing which enemy to attack in a Pokémon battle.
You are given the move you will use and the list of enemy Pokémon on the field.
Pick the best target based on type effectiveness, predicted damage, and threat level.

Respond with ONLY a raw JSON object, no markdown, no prose:
{"targetIndex":<0-based index into the enemy list>,"reasoning":"<one sentence>"}`;

function installSelectTargetPatch(): void {
  SelectTargetPhase.prototype.start = function start(this: SelectTargetPhase): void {
    if (!enabled) {
      return originalSelectTargetStart.call(this);
    }
    void llmSelectTargetFlow(this);
  } as (this: SelectTargetPhase) => void;
}

async function llmSelectTargetFlow(phase: SelectTargetPhase): Promise<void> {
  try {
    const turnCommand = globalScene.currentBattle.turnCommands[phase.fieldIndex];
    const moveId = turnCommand?.move?.move;
    if (!moveId) {
      phase.end();
      return;
    }
    // If targets already set by CommandPhase AI decision, skip
    if (turnCommand?.move?.targets && turnCommand.move.targets.length > 0) {
      console.log(`[ai-llm] targets already set, skipping SelectTargetPhase`);
      phase.end();
      return;
    }
    const enemyField = globalScene.getEnemyField().filter(p => p.isActive(true));
    if (enemyField.length === 0) {
      phase.end();
      return;
    }
    // Single target — no LLM call needed
    if (enemyField.length === 1) {
      turnCommand.move!.targets = [enemyField[0].getBattlerIndex()];
      phase.end();
      return;
    }
    const move = allMoves[moveId];
    const user = globalScene.getField()[phase.fieldIndex];
    const lines: string[] = [];
    lines.push(`YOUR MOVE: ${move.name} (${MoveId[move.id]}, ${typeName(move.type)} ${CATEGORY_LABEL[move.category]}, power ${move.power})`);
    lines.push(`USER: ${user.getName()} Lv ${user.level}, types ${user.getTypes().map(t => typeName(t)).join("/")}`);
    lines.push("=== ENEMY TARGETS (pick one by index) ===");
    enemyField.forEach((e, i) => {
      const maxHp = e.getMaxHp();
      const hpPct = maxHp > 0 ? Math.round((e.hp / maxHp) * 100) : 0;
      const types = e.getTypes().map(t => typeName(t)).join("/");
      const stab = user.getTypes().includes(move.type) ? ", STAB" : "";
      lines.push(`  [${i}] ${e.getName()} Lv ${e.level}, types ${types}, HP ${e.hp}/${maxHp} (${hpPct}%)${stab}`);
    });
    const prompt = lines.join("\n");
    const content = await callRegolo(prompt, TARGET_PROMPT);
    let targetIndex = 0;
    if (content) {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]) as { targetIndex?: number; reasoning?: string };
          if (typeof parsed.targetIndex === "number" && parsed.targetIndex >= 0 && parsed.targetIndex < enemyField.length) {
            targetIndex = parsed.targetIndex;
            if (parsed.reasoning) {
              showReasoning(`Target: ${parsed.reasoning}`);
            }
          }
        } catch { /* ignore */ }
      }
    }
    const target = enemyField[targetIndex];
    turnCommand.move!.targets = [target.getBattlerIndex()];
    console.log(`[ai-llm] target selected: ${target.getName()} (index ${targetIndex})`);
    phase.end();
  } catch (e) {
    console.warn("[ai-llm] target select error, using first target:", e);
    const turnCommand = globalScene.currentBattle.turnCommands[phase.fieldIndex];
    const enemyField = globalScene.getEnemyField().filter(p => p.isActive(true));
    if (turnCommand?.move && enemyField.length > 0) {
      turnCommand.move.targets = [enemyField[0].getBattlerIndex()];
    }
    phase.end();
  }
}

// ─── Auto-advance: tutorials, messages, confirm dialogs ────────────────

const originalShowPrompt = MessageUiHandler.prototype.showPrompt as (this: MessageUiHandler, callback?: (() => void) | null, callbackDelay?: number | null) => void;

function installAutoAdvancePatch(): void {
  MessageUiHandler.prototype.showPrompt = function showPrompt(this: MessageUiHandler, callback?: (() => void) | null, callbackDelay?: number | null): void {
    if (enabled && callback) {
      globalScene.time.delayedCall(1000, () => {
        callback();
      });
      return;
    }
    return originalShowPrompt.call(this, callback, callbackDelay);
  } as (this: MessageUiHandler, callback?: (() => void) | null, callbackDelay?: number | null) => void;

  const originalConfirmShow = ConfirmUiHandler.prototype.show;
  ConfirmUiHandler.prototype.show = function show(this: ConfirmUiHandler, args: any[]): boolean {
    const result = originalConfirmShow.call(this, args);
    if (enabled && result) {
      globalScene.time.delayedCall(1000, () => {
        this.processInput(0);
      });
    }
    return result;
  } as (this: ConfirmUiHandler, args: any[]) => boolean;

  // Auto-advance level-up stat screens (promptLevelUpStats sets awaitingActionInput without showPrompt)
  const originalPromptLevelUpStats = BattleMessageUiHandler.prototype.promptLevelUpStats as (this: BattleMessageUiHandler, partyMemberIndex: number, prevStats: number[], showTotals: boolean) => Promise<void>;
  BattleMessageUiHandler.prototype.promptLevelUpStats = function promptLevelUpStats(this: BattleMessageUiHandler, partyMemberIndex: number, prevStats: number[], showTotals: boolean): Promise<void> {
    const promise = originalPromptLevelUpStats.call(this, partyMemberIndex, prevStats, showTotals);
    if (enabled) {
      globalScene.time.delayedCall(1500, () => {
        if (this.awaitingActionInput) {
          this.processInput(Button.ACTION);
        }
      });
    }
    return promise;
  } as (this: BattleMessageUiHandler, partyMemberIndex: number, prevStats: number[], showTotals: boolean) => Promise<void>;
}

export async function initAiLlm(): Promise<void> {
  loadFromStorage();
  if (!enabled) {
    await showOverlay();
  }
  installCommandPatch();
  installLoginPatch();
  installTitlePatch();
  installStarterPatch();
  installLearnMovePatch();
  installCheckSwitchPatch();
  installSwitchPatch();
  installSelectTargetPatch();
  installAutoAdvancePatch();
  installSelectModifierPatch();
  showBadge();
  showPartyPanel();
}
