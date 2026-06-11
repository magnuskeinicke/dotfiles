local M = {
  "nvim-lualine/lualine.nvim",
  dependencies = { "nvim-tree/nvim-web-devicons" },
  opts = function()
    local C = require("catppuccin.palettes").get_palette("mocha")
    local transparent = "NONE"
    -- LSP clients that are really linters; shown in the linter group instead.
    local linter_clients = { oxlint = true, eslint = true }

    local function dedup(list)
      local seen, out = {}, {}
      for _, v in ipairs(list) do
        if not seen[v] then
          seen[v] = true
          out[#out + 1] = v
        end
      end
      return out
    end

    -- One source of truth for all three groups; cached briefly since the
    -- conform/lint condition checks walk the filesystem and lualine calls
    -- these functions several times per redraw.
    local cache = { time = 0 }
    local function get_groups()
      local now = (vim.uv or vim.loop).now()
      local bufnr = vim.api.nvim_get_current_buf()
      if cache.bufnr == bufnr and now - cache.time < 500 then
        return cache.servers, cache.linters, cache.formatters
      end
      local buf_ft = vim.bo.filetype

      local servers = {}
      local linters = {}
      for _, client in pairs(vim.lsp.get_clients({ bufnr = bufnr })) do
        if client.name ~= "null-ls" and client.name ~= "GitHub Copilot" and client.name ~= "copilot" then
          table.insert(linter_clients[client.name] and linters or servers, client.name)
        end
      end

      -- nvim-lint linters for this filetype, honoring LazyVim's `condition`
      -- extension so gated linters don't show where they won't run.
      local lint_ok, lint = pcall(require, "lint")
      if lint_ok then
        local ctx = { filename = vim.api.nvim_buf_get_name(bufnr) }
        ctx.dirname = vim.fn.fnamemodify(ctx.filename, ":h")
        for _, name in ipairs(lint._resolve_linter_by_ft(buf_ft)) do
          local linter = lint.linters[name]
          if linter and not (type(linter) == "table" and linter.condition and not linter.condition(ctx)) then
            table.insert(linters, name)
          end
        end
      end

      -- Formatters that will actually run (evaluates conditions, require_cwd
      -- and stop_after_first), unlike list_formatters_for_buffer which lists
      -- everything configured for the filetype.
      local formatters = {}
      local conform_ok, conform = pcall(require, "conform")
      if conform_ok then
        for _, f in ipairs(conform.list_formatters_to_run(bufnr)) do
          table.insert(formatters, f.name)
        end
      end

      cache = {
        bufnr = bufnr,
        time = now,
        servers = dedup(servers),
        linters = dedup(linters),
        formatters = dedup(formatters),
      }
      return cache.servers, cache.linters, cache.formatters
    end

    local lsp = {
      function()
        local servers = get_groups()
        if #servers == 0 then
          return "  No servers"
        end
        return "󰅡 " .. table.concat(servers, ", ")
      end,
      separator = { left = "", right = "" },
    }

    local linters_group = {
      function()
        local _, linters = get_groups()
        return "󰚔 " .. table.concat(linters, ", ")
      end,
      cond = function()
        local _, linters = get_groups()
        return #linters > 0
      end,
      separator = { left = "", right = "" },
      color = { bg = C.yellow, fg = C.mantle },
    }

    local formatters_group = {
      function()
        local _, _, formatters = get_groups()
        return "󰉼 " .. table.concat(formatters, ", ")
      end,
      cond = function()
        local _, _, formatters = get_groups()
        return #formatters > 0
      end,
      separator = { left = "", right = "" },
      color = { bg = C.green, fg = C.mantle },
    }
    local modes = {
      "mode",
      separator = { left = "", right = "" },
    }

    local space = {
      function()
        return " "
      end,
      color = { fg = transparent, bg = transparent },
    }

    local filename = {
      "filename",
      separator = { left = "", right = "" },
      color = { bg = C.teal, fg = C.mantle },
    }
    local filetype = {
      "filetype",
      icons_enabled = true,
      separator = { left = "", right = "" },
      color = { bg = C.surface0, fg = C.text },
    }

    local branch = {
      "branch",
      icon = "",
      separator = { left = "", right = "" },
      color = { fg = C.mantle, bg = C.peach },
    }

    local diff = {
      "diff",
      separator = { left = "", right = "" },
      symbols = { added = " ", modified = " ", removed = " " },
      color = { fg = C.text, bg = C.surface0 },
    }

    local location = {
      "location",
      separator = { left = "", right = "" },
      color = { fg = C.mantle, bg = C.maroon },
    }

    local progress = {
      "progress",
      separator = { left = "", right = "" },
      color = { fg = C.text, bg = C.surface0 },
    }

    local diagnostics = {
      "diagnostics",
      separator = { left = "", right = "" },
      color = { fg = C.text, bg = C.surface0 },
    }

    return {
      options = {
        theme = "catppuccin-nvim",
        icons_enabled = true,
        component_separators = { left = "", right = "" },
        section_separators = { left = "", right = "" },
        ignore_focus = {},
        always_divide_middle = true,
        globalstatus = true,
      },

      sections = {
        lualine_a = { modes },
        lualine_b = { space },
        lualine_c = {
          filename,
          filetype,
          space,
          branch,
          diff,
          space,
          location,
          progress,
          space,
          diagnostics,
        },
        lualine_x = { space },
        lualine_y = { space },
        lualine_z = { formatters_group, space, linters_group, space, lsp },
      },
    }
  end,
}
return M
