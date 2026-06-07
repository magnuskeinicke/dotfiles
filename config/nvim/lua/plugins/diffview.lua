-- Base revision used by the branch-diff keybinds below; kept in one place so
-- the "sync to current file" action and its fallback stay consistent with it.
local DIFF_BASE = "origin/development...HEAD"

-- Re-point the *active* Diffview at whatever file the cursor is currently in
-- (e.g. after a `gd` jump), without leaving the session or touching the file
-- tree. Falls back to a single-file diff against DIFF_BASE when there is no
-- active view or the file is not part of the current changeset.
local function diff_current_file()
  local target = vim.fn.expand("%:p")
  local view = require("diffview.lib").get_current_view()

  if view and view.set_file then
    for _, file in view.files:iter() do
      if file.absolute_path == target then
        view:set_file(file, false, true) -- focus=false, highlight panel entry
        return
      end
    end
  end

  vim.cmd("DiffviewOpen " .. DIFF_BASE .. " -- " .. vim.fn.fnameescape(target))
end

-- Focus the left ("a", base) or right ("b", local) window of the active diff.
-- No-op when no view is active or the layout lacks that side.
local function focus_diff_side(side)
  return function()
    local view = require("diffview.lib").get_current_view()
    local win = view and view.cur_layout and view.cur_layout[side]
    if win and win.focus then
      win:focus()
    end
  end
end

return {
  "sindrets/diffview.nvim",
  cmd = {
    "DiffviewOpen",
    "DiffviewClose",
    "DiffviewToggleFiles",
    "DiffviewFocusFiles",
    "DiffviewRefresh",
    "DiffviewFileHistory",
  },
  dependencies = { "nvim-lua/plenary.nvim" },
  opts = {
    default_args = {
      DiffviewOpen = { "--imply-local" },
    },
  },
  keys = {
    { "<leader>gv", "", desc = "+diffview" },
    { "<leader>gvd", "<cmd>DiffviewOpen " .. DIFF_BASE .. "<cr>", desc = "Diff branch vs origin/development" },
    { "<localleader>d", diff_current_file, desc = "Diffview: sync diff to current file" },
    { "<localleader>f", function() require("diffview.actions").focus_files() end, desc = "Diffview: focus file tree" },
    { "<localleader>n", function() require("diffview.actions").select_next_entry() end, desc = "Diffview: next file" },
    { "<localleader>p", function() require("diffview.actions").select_prev_entry() end, desc = "Diffview: prev file" },
    { "<localleader>l", focus_diff_side("a"), desc = "Diffview: focus left diff file" },
    { "<localleader>r", focus_diff_side("b"), desc = "Diffview: focus right diff file" },
    { "<localleader>q", "<cmd>DiffviewClose<cr>", desc = "Diffview: close" },
    { "<leader>gvl", "<cmd>DiffviewOpen<cr>", desc = "Diff working tree vs HEAD (local changes)" },
    { "<leader>gvh", "<cmd>DiffviewFileHistory %<cr>", desc = "File history (current file)" },
    { "<leader>gvf", "<cmd>DiffviewFileHistory --range=origin/development...HEAD --right-only --no-merges<cr>", desc = "Branch commits vs origin/development" },
    { "<leader>gvc", "<cmd>DiffviewClose<cr>", desc = "Close diffview" },
  },
}
