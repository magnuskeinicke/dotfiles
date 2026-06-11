-- Keep sidekick for its AI CLI integration, but disable Copilot next-edit suggestions.
return {
  "folke/sidekick.nvim",
  opts = {
    nes = { enabled = false },
  },
}
