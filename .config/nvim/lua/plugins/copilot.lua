local M = {
  "github/copilot.vim",
  event = "InsertEnter",
  keys = {
    {
      "<M-y>",
      'copilot#Accept("\\<CR>")',
      mode = "i",
      expr = true,
      replace_keycodes = false,
      desc = "Accept Copilot suggestion",
    },
    { "<M-w>", "<Plug>(copilot-accept-word)", mode = "i", desc = "Copilot accept word" },
    { "<M-l>", "<Plug>(copilot-accept-line)", mode = "i", desc = "Copilot accept line" },
    { "<M-e>", "<Plug>(copilot-dismiss)", mode = "i", desc = "Copilot dismiss suggestion" },
    { "<M-n>", "<Plug>(copilot-next)", mode = "i", desc = "Copilot next suggestion" },
    { "<M-p>", "<Plug>(copilot-previous)", mode = "i", desc = "Copilot previous suggestion" },
    { "<M-\\>", "<Plug>(copilot-suggest)", mode = "i", desc = "Copilot force suggestion" },
  },
}
return M
