-- Options are automatically loaded before lazy.nvim startup
-- Default options that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/options.lua
-- Add any additional options here

-- Override LazyVim default localleader ("\") to avoid colliding with mini.files
vim.g.maplocalleader = ','

-- Only run prettier when a prettier config file is present, so oxc projects
-- (which use oxfmt, see lua/plugins/oxc.lua) don't get formatted by prettier.
vim.g.lazyvim_prettier_needs_config = true

-- Show Copilot suggestions as inline ghost text instead of in the completion menu
vim.g.ai_cmp = false
