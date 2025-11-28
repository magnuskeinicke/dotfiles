local M = {
  "kdheepak/lazygit.nvim",
  lazy = true,
  cmd = {
    "LazyGit",
    "LazyGitConfig",
    "LazyGitCurrentFile",
    "LazyGitFilter",
    "LazyGitFilterCurrentFile",
    "LazyGitLog",
  },
  dependencies = {
    "nvim-lua/plenary.nvim",
  },
  keys = {
    { "<leader>lg", "<cmd>LazyGit<cr>", desc = "Open lazygit" },
    {
      "<leader>lc",
      "<cmd>LazyGitFilter<cr>",
      desc = "Open project commits in lazygit",
    },
    {
      "<leader>lb",
      "<cmd>LazyGitFilterCurrentFile<cr>",
      desc = "Open buffer commits in lazygit",
    },
    {
      "<leader>ll",
      "<cmd>LazyGitLog<cr>",
      desc = "Open git log in lazygit",
    },
  },
}
return M
