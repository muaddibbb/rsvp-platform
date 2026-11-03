# Updating the live n8n workflow for the no-auto-resume change

Do this after the release commit is approved. Do it all in one sitting, away from 05:00, which is when the schedule runs.

1. **Backup first.** n8n → workflow **"RSVP Ads Campaign Manager"** → the "⋯" menu at the top right → **Download**. Save it outside Downloads, for example `/Users/rkuperman/n8n-backup/campaign-manager-live.json`. This file contains your real developer token in the headers: **do not send it, paste it into chat, or commit it.**
2. **Check that your live code nodes equal the repo's** (read-only, in Terminal):
   ```
   cd /Users/rkuperman/rsvp-platform && node -e 'const live=require(process.argv[1]); const base=JSON.parse(require("child_process").execSync("git show 59e4ea4:automation/campaign-manager.workflow.json")); for (const n of ["Normalize","Rules Engine"]) { const a=live.nodes.find(x=>x.name===n), b=base.nodes.find(x=>x.name===n); console.log(n, a&&b&&a.parameters.jsCode===b.parameters.jsCode ? "SAME" : "DIFFERENT"); }' /Users/rkuperman/n8n-backup/campaign-manager-live.json
   ```
   If both say **SAME**, continue. If either says **DIFFERENT**, stop and tell the team which one. Your live copy has changes the repo doesn't know about, and pasting would remove them.
3. **Add the new read node.** On the canvas, right-click **"Read: Campaign Status"** → **Duplicate**. This keeps the URL, the Google Ads credential and both headers, including your real developer token. Click the copy's title and rename it to exactly **`Read: Campaign Changes`**. Open it. In **Body**, make sure the field is in **Expression** mode, select all the text and replace it with the output of:
   ```
   cd /Users/rkuperman/rsvp-platform && git show <RELEASE-SHA>:automation/campaign-manager.workflow.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).nodes.find(n=>n.name==="Read: Campaign Changes").parameters.jsonBody.slice(1)))' | pbcopy
   ```
   That command puts the text on the clipboard without the leading "=". Then open the node's **Settings** tab → **On Error** → **Continue** (regular output). Close the node.
4. **Rewire.** Hover the arrow from "Read: Campaign Status" to "Read: Keywords 30d" → trash icon. Drag from Status's output dot to "Read: Campaign Changes", then from "Read: Campaign Changes" to "Read: Keywords 30d".
5. **Paste "Normalize".** Run
   `cd /Users/rkuperman/rsvp-platform && git show <RELEASE-SHA>:automation/campaign-manager.workflow.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).nodes.find(n=>n.name===process.argv[1]).parameters.jsCode))' "Normalize" | pbcopy`.
   Open the **Normalize** node, click into the code, press **Cmd+A**, then **Cmd+V**. Close it.
6. **Paste "Rules Engine".** Run the same command with `"Rules Engine"` in place of `"Normalize"`, then paste it into the **Rules Engine** node the same way.
7. **Save:** press **Cmd+S** (the top bar shows "Saved"). **Reload the browser tab.** Reopen **Rules Engine** and confirm that the first line ends with `resumes only the agent's own cap pause (pausedByAgent).`. Reopen **Normalize** and use Cmd+F to find `Read: Campaign Changes`. If either is missing, the edit did not persist (README lesson 8): paste again and save.
8. **Read-only test.** Open **Rules Engine** and press **Test step** (n8n runs the read nodes and Normalize first, and **nothing after Rules Engine runs**).
   - In Normalize's output, `pausedByAgent` should be `false` if you paused the campaign yourself, and `lastStatusChange.clientType` should be `GOOGLE_ADS_WEB_CLIENT` (or `GOOGLE_ADS_MOBILE_APP`). If you paused it more than 28 days ago (the change history window), `lastStatusChange` is `null`. That is normal: `pausedByAgent` is still `false` and the campaign simply stays paused (no resume).
   - Rules Engine's `candidateActions` must contain **no** `resume_campaign` in that case, and `notes` says "not resuming".
   - **Never press "Test workflow"**: it runs "Apply to Google Ads" for real, because DRY_RUN is false.
   - If "Read: Campaign Changes" shows an error, send the team the error text (not the token). The daily run still enforces the budget because of On Error → Continue; it just won't auto-resume.
9. Nothing to add in Google Ads itself: no label, no new setting, and the developer token needs no extra access.
