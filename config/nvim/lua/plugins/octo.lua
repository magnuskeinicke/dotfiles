return {
  "pwntester/octo.nvim",
  opts = {
    -- Use on-disk files for the right/head side of reviews so LSP can attach.
    -- Requires being checked out on the PR branch (`:Octo pr checkout`).
    use_local_fs = true,
  },
  keys = {
    {
      "<localleader>o",
      function()
        local octo_bufs = vim.tbl_filter(function(b)
          return b.loaded == 1 and b.name:match("^octo://")
        end, vim.fn.getbufinfo())
        if #octo_bufs == 0 then
          vim.notify("No octo buffer open", vim.log.levels.WARN)
          return
        end
        table.sort(octo_bufs, function(a, b)
          return a.lastused > b.lastused
        end)
        vim.api.nvim_set_current_buf(octo_bufs[1].bufnr)
      end,
      desc = "Jump back to octo buffer",
    },
  },
}
