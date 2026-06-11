-- Helpers for reviewing only *new* changes in an Octo PR review.
--
-- Octo's built-in `:Octo review commit` (`<localleader>C`) only shows a single
-- commit (parent..commit) or the whole PR. It cannot diff an arbitrary range,
-- because its non-full-PR path fetches `/commits/{sha}` (one commit). To diff a
-- true range we use GitHub's compare API (`/compare/{base}...{head}`), which
-- returns the same file shape Octo's FileEntry expects.

---Rebuild the active review layout to show the diff of `left_sha`..`right_sha`.
---@param review table current review (from reviews.get_current_review())
---@param left_sha string base commit (left side)
---@param right_sha string head commit (right side)
local function focus_range(review, left_sha, right_sha)
  local Layout = require("octo.reviews.layout").Layout
  local Rev = require("octo.reviews.rev").Rev
  local FileEntry = require("octo.reviews.file-entry").FileEntry
  local gh = require("octo.gh")
  local utils = require("octo.utils")
  local pr = review.pull_request

  if left_sha == right_sha then
    utils.info("No new changes: already reviewed up to HEAD")
    return
  end

  review.layout:close()
  review.layout = Layout:new {
    left = Rev:new(left_sha),
    right = Rev:new(right_sha),
    files = {},
  }
  review.layout:open(review)

  gh.api.get {
    "/repos/{repo}/compare/{basehead}",
    format = { repo = pr.repo, basehead = left_sha .. "..." .. right_sha },
    paginate = true,
    slurp = true,
    opts = {
      cb = gh.create_callback {
        success = function(output)
          local pages = vim.json.decode(output)
          -- Concatenate `files` across pages (compare paginates the files array).
          local files = {}
          for _, page in ipairs(pages) do
            if type(page) == "table" and page.files then
              for _, result in ipairs(page.files) do
                files[#files + 1] = FileEntry:new {
                  path = result.filename,
                  previous_path = result.previous_filename,
                  patch = result.patch,
                  pull_request = pr,
                  status = utils.file_status_map[result.status],
                  stats = {
                    additions = result.additions,
                    deletions = result.deletions,
                    changes = result.changes,
                  },
                }
              end
            end
          end
          if #files == 0 then
            utils.info("No changed files in selected range")
          end
          review:set_files_and_select_first(files)
        end,
      },
    },
  }
end

---Get the active review, or nil + notify if none is started/resumed.
local function active_review()
  local reviews = require("octo.reviews")
  local review = reviews.get_current_review()
  if not review or review.id == -1 then
    require("octo.utils").error("Start or resume a review first (:Octo review start)")
    return nil
  end
  return review
end

---Review only changes pushed since my last submitted review.
---Falls back to the whole PR if I have never reviewed it.
local function review_since_last_review()
  local review = active_review()
  if not review then
    return
  end
  local gh = require("octo.gh")
  local utils = require("octo.utils")
  local pr = review.pull_request

  gh.api.get {
    "/repos/{repo}/pulls/{number}/reviews",
    format = { repo = pr.repo, number = pr.number },
    paginate = true,
    slurp = true,
    opts = {
      cb = gh.create_callback {
        success = function(output)
          local pages = vim.json.decode(output)
          local me = vim.g.octo_viewer
          local base, base_time
          for _, page in ipairs(pages) do
            for _, r in ipairs(type(page) == "table" and page or {}) do
              if r.user and r.user.login == me and r.state ~= "PENDING" and r.commit_id then
                if not base_time or (r.submitted_at and r.submitted_at > base_time) then
                  base = r.commit_id
                  base_time = r.submitted_at
                end
              end
            end
          end
          if not base then
            utils.info("No prior review found — showing whole PR")
            base = pr.left.commit
          end
          focus_range(review, base, pr.right.commit)
        end,
      },
    },
  }
end

---Pick a base commit; review everything from that commit to HEAD (base..HEAD).
local function review_since_commit()
  local review = active_review()
  if not review then
    return
  end
  -- Reuse Octo's commit picker. It calls back with (right, left) for the
  -- selected commit; we ignore those and instead use the selected sha as the
  -- *base*, diffing base..HEAD so all later commits are included.
  require("octo.picker").review_commits(review, function(right, _left)
    focus_range(review, right, review.pull_request.right.commit)
  end)
end

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
    {
      "<localleader>N",
      review_since_last_review,
      desc = "Octo: review changes since my last review",
    },
    {
      "<localleader>B",
      review_since_commit,
      desc = "Octo: review changes since picked commit (base..HEAD)",
    },
  },
}
