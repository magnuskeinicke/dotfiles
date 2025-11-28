local M = {
  "nvim-lualine/lualine.nvim",
  dependencies = { "nvim-tree/nvim-web-devicons" },
  opts = function()
    local C = require("catppuccin.palettes").get_palette("mocha")
    local transparent = "NONE"
    local function getLspName()
      local bufnr = vim.api.nvim_get_current_buf()
      local buf_clients = vim.lsp.get_clients({ bufnr = bufnr })
      local buf_ft = vim.bo.filetype
      if next(buf_clients) == nil then
        return "  No servers"
      end
      local buf_client_names = {}

      for _, client in pairs(buf_clients) do
        if client.name ~= "null-ls" then
          table.insert(buf_client_names, client.name)
        end
      end

      local lint_s, lint = pcall(require, "lint")
      if lint_s then
        for ft_k, ft_v in pairs(lint.linters_by_ft) do
          if type(ft_v) == "table" then
            for _, linter in ipairs(ft_v) do
              if buf_ft == ft_k then
                table.insert(buf_client_names, linter)
              end
            end
          elseif type(ft_v) == "string" then
            if buf_ft == ft_k then
              table.insert(buf_client_names, ft_v)
            end
          end
        end
      end

      local ok, conform = pcall(require, "conform")
      local formatters = table.concat(conform.list_formatters_for_buffer(), " ")
      if ok then
        for formatter in formatters:gmatch("%w+") do
          if formatter then
            table.insert(buf_client_names, formatter)
          end
        end
      end

      local hash = {}
      local unique_client_names = {}

      for _, v in ipairs(buf_client_names) do
        if not hash[v] and v ~= "GitHub Copilot" then
          unique_client_names[#unique_client_names + 1] = v
          hash[v] = true
        end
      end
      local language_servers = table.concat(unique_client_names, ", ")

      return "󰅡 " .. language_servers
    end

    local lsp = {
      function()
        return getLspName()
      end,
      separator = { left = "", right = "" },
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
        theme = "catppuccin",
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
        lualine_z = { lsp },
      },
    }
  end,
}
return {}
