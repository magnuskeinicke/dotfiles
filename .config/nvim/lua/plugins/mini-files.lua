return {
  "nvim-mini/mini.files",
  opts = {
    mappings = {
      go_in_plus = "<CR>",
    },
  },
  keys = {
    {
      "\\",
      function()
        local files = require("mini.files")
        if files.get_explorer_state() then
          files.close()
        else
          files.open(vim.api.nvim_buf_get_name(0), true)
        end
      end,
      desc = "Open mini.files (Directory of Current File)",
    },
    {
      "|",
      function()
        local files = require("mini.files")
        if files.get_explorer_state() then
          files.close()
        else
          files.open(vim.uv.cwd(), true)
        end
      end,
      desc = "Open mini.files (cwd)",
    },
  },
}
