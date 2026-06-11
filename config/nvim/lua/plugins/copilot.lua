-- Copilot via the LazyVim ai.copilot extra (copilot.lua).
-- Ghost text enabled through vim.g.ai_cmp = false (see config/options.lua).
return {
  "zbirenbaum/copilot.lua",
  opts = {
    suggestion = {
      keymap = {
        accept = "<M-y>",
        accept_word = "<M-w>",
        accept_line = "<M-l>",
        dismiss = "<M-e>",
        next = "<M-n>",
        prev = "<M-p>",
      },
    },
  },
  keys = {
    {
      "<M-\\>",
      function() require("copilot.suggestion").next() end,
      mode = "i",
      desc = "Copilot force suggestion",
    },
  },
}
