-- Make the `lang.typescript.oxc` extra coexist with the prettier/eslint extras
-- so each project uses the right tool automatically:
--
--   * Linting is already auto-gated by the oxc extra (oxlint LSP attaches only
--     when an .oxlintrc.json root exists) and the eslint extra (eslint LSP
--     attaches only when an eslint config exists). No change needed here.
--
--   * Formatting: the oxc extra appends conform's builtin `oxfmt` formatter, and
--     the prettier extra appends `prettier`, to the same filetypes. Without
--     gating, both run in every project. We fix that with two conditions:
--       - prettier: vim.g.lazyvim_prettier_needs_config = true (set in
--         lua/config/options.lua) -> prettier only runs where a prettier config
--         is found.
--       - oxfmt: require_cwd = true with a cwd resolved from oxfmt config files
--         only -> oxfmt only runs where an .oxfmtrc.json (etc.) is found.
--     stop_after_first ensures that even if a project somehow had both configs,
--     only the first matching formatter runs instead of both.

-- Filetypes the oxc extra maps to oxfmt (kept in sync with that extra's list).
local oxfmt_filetypes = {
  "javascript",
  "javascriptreact",
  "typescript",
  "typescriptreact",
  "json",
  "jsonc",
  "vue",
  "svelte",
  "astro",
}

return {
  "stevearc/conform.nvim",
  optional = true,
  ---@param opts ConformOpts
  opts = function(_, opts)
    opts.formatters = opts.formatters or {}
    -- Override the builtin oxfmt: only run when an oxfmt config is found upward.
    -- (The builtin's default cwd also matches vite.config.*, which would falsely
    -- trigger oxfmt in plain Vite projects; restrict it to oxfmt configs.)
    opts.formatters.oxfmt = {
      require_cwd = true,
      cwd = require("conform.util").root_file({
        ".oxfmtrc.json",
        ".oxfmtrc.jsonc",
        "oxfmt.config.ts",
      }),
    }

    opts.formatters_by_ft = opts.formatters_by_ft or {}
    for _, ft in ipairs(oxfmt_filetypes) do
      local list = opts.formatters_by_ft[ft]
      if list then
        -- Both extras loaded before this spec, so prettier + oxfmt are already
        -- in the list; just stop after whichever one's condition passes.
        list.stop_after_first = true
      end
    end
  end,
}
