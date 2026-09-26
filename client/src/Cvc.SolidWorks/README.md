# CVC add-in for SolidWorks 2025

Check files in and out without leaving SolidWorks. The add-in adds a **CVC** tab to the
task pane with three parts:

- **Active document:** its version and who has it checked out, with Check out,
  Check in, Undo check-out and Get latest buttons.
- **Needs attention:** your new, changed, and checked-out files, plus files that are
  out of date or checked out by others. Right-click for actions; double-click to open.
- **Sign-in and workspace:** set once. The workspace is `C:\CVC` on every computer, so
  assembly references resolve for everyone.

While you work:
- **Start editing a file you haven't checked out** and CVC offers to check it out.
  Saving such a file also offers a check-out first, then saves it in place, or explains
  why it can't be saved (someone else has it, or there's a newer version) and offers to
  save your changes under another name.
- **Check in an assembly** and the new parts it uses, and the parts you changed, go
  into the same check-in. Each is recorded with the version it used, and SolidWorks
  is asked what the assembly references.
- **Getting the latest version** of an open file closes it, updates it, and reopens
  it. Files with unsaved changes are never closed for you.

## Install

1. Get the add-in folder: the `cvc-solidworks-addin` artifact from a CI run, or
   `dotnet build -c Release client/src/Cvc.SolidWorks` (the output is
   `bin/Release/net48`).
2. Put it somewhere permanent, e.g. `C:\Program Files\CVC\addin`.
3. In PowerShell **as administrator**, in that folder:
   ```
   powershell -ExecutionPolicy Bypass -File install.ps1
   ```
4. Start SolidWorks 2025. Open the CVC tab in the task pane, enter the server address,
   and sign in. Your browser opens; confirm there.

If the CVC tab doesn't appear, check **Tools > Add-ins** and tick CVC (both boxes, so it
loads at startup). To remove the add-in, run `uninstall.ps1` the same way.

## Testing against a development server

A dev server on a Mac can serve a Windows PC on the same network:

```
cd server && CVC_DEV_AUTH=1 CVC_BOOTSTRAP_ADMINS=you@example.com CVC_HOST=0.0.0.0 uv run cvc-server
```

In the add-in, use `http://<the Mac's IP address>:8000` as the server, and sign in with
the development form as `you@example.com`.

## Manual checks before a release

The add-in can't be tested automatically (that would need SolidWorks), so run through
these on SolidWorks 2025:

1. After installing, SolidWorks starts with the CVC tab, and `addin.log` says the add-in
   started.
2. Sign in: your browser opens, you confirm, and the tab shows your name and
   `C:\CVC`.
3. Save a new part into `C:\CVC\Test`. The tab says "New". Check it in with a comment,
   and the part turns read-only in SolidWorks.
4. Start editing it. CVC offers a check-out; accept, save, and check in: it's now v2.
5. As a second person (another PC, or `cvc checkout` as someone else), check the part
   out. The first PC shows who has it. Change the part there and save: CVC says who has
   it, and offers to save your changes under another name.
6. Make an assembly from a new part and an existing part, then check in the assembly.
   The new part goes in too, and `cvc history` on the assembly lists both references
   with their versions.
7. With a newer version checked in elsewhere, click Get latest on the open file. It
   closes, updates, and reopens.
8. Undo a check-out that has changes. The file goes back to the vault's version, and
   your copy is in `C:\CVC\.cvc\backup`.
9. On a display scaled above 100% (most laptops; Settings > System > Display > Scale),
   the CVC tab and the Check in dialog look as they do at 100%, only larger: no text is
   cut off, and the comment box is full size.
10. Create a new part, save it into `C:\CVC\Test`, and check it in. Without switching
    windows, start editing it: CVC offers the check-out.
11. Change a checked-in file, answer No when CVC offers the check-out, then save
    (Ctrl+S). CVC offers the check-out again; Yes saves the file in place, with no Save
    As dialog.

## When something goes wrong

The add-in logs to `%LOCALAPPDATA%\CVC\addin.log`. Settings are in
`%APPDATA%\CVC\addin.json`, and saved sign-ins (encrypted) are in
`%APPDATA%\CVC\tokens.json`. The `cvc` CLI uses the same workspace and sign-in, so
`cvc status` in `C:\CVC` is a good second opinion.
