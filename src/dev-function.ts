/**
 * Custom function that can be used in the dev environment to help testing without having to use the debugger or make temporary code changes.
 * Default Button mapping is `Q`, but can be changed in the keyboard settings.
 * @privateremarks
 * This file should _NOT_ be committed and only used for temporary testing purposes.
 */
import { globalScene } from "#app/global-scene";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { getGameMode } from "#app/game-mode";
import { Tutorial } from "#app/tutorial";
import { Gender } from "#data/gender";
import { GameModes } from "#enums/game-modes";
import { Nature } from "#enums/nature";
import { PlayerGender } from "#enums/player-gender";
import { SpeciesId } from "#enums/species-id";

export async function customDevFunction() {
  // Expose everything needed for headless automation.
  (globalThis as unknown as Record<string, unknown>).globalScene = globalScene;
  (globalThis as unknown as Record<string, unknown>).__dev = {
    globalScene,
    speciesDataRegistry,
    getGameMode,
    GameModes,
    SpeciesId,
    Gender,
    Nature,
    startTestBattle: () => {
      const scene = globalScene;
      scene.gameMode = getGameMode(GameModes.CLASSIC);

      // Skip login/gender/tutorial gates so EncounterPhase runs immediately
      scene.gameData.gender = PlayerGender.MALE;
      scene.gameData.saveTutorialFlag(Tutorial.INTRO, true);

      const species = speciesDataRegistry.getSpecies(SpeciesId.RATTATA);
      const pokemon = scene.addPlayerPokemon(species, 5, 0, 0, Gender.MALE, false, 0, [], Nature.HARDY);
      pokemon.setVisible(false);
      scene.getPlayerParty().push(pokemon);

      scene.newArena(scene.gameMode.getStartingBiome());
      scene.newBattle();
      scene.arena.init();

// LoginPhase is stuck and won't call end() to advance the queue.
      // overridePhase replaces it with EncounterPhase and starts immediately.
      // Clear standby afterward so EncounterPhase.end() → turnStart() (TurnInitPhase),
      // not a resume of the stuck LoginPhase.
      scene.phaseManager.clearPhaseQueue();
      const encounter = scene.phaseManager.create("EncounterPhase", false);
      scene.phaseManager.overridePhase(encounter);
      (scene.phaseManager as unknown as { standbyPhase: unknown }).standbyPhase = null;

      console.log("[dev] test battle started");
    },
  };
  console.log("[dev] globalScene + __dev exposed on globalThis. Call __dev.startTestBattle() to begin.");
}
