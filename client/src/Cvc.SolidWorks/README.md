# Vault add-in for SolidWorks 2025

Check files in and out without leaving SolidWorks. The add-in adds a **Vault** tab to the
task pane with these parts:

- **Active document:** its version and who has it checked out, with Check out,
  Check in, Undo check-out and Get latest buttons, and Open drawing when it has one.
- **Needs attention:** your new, changed, and checked-out files, plus files that are
  out of date or checked out by others. Right-click for actions; double-click to open.
- **Browse:** the whole vault as a tree, folder by folder. Every file says whether it's
  checked in, or who has it checked out and where; every folder how many of its files
  are checked out. Assemblies open up to show their parts and sub-assemblies (with the
  version each was checked in with), and parts and assemblies list their drawings. Hover
  for where a file is used. Double-click to open: a file that isn't here yet is
  downloaded first, with the parts it uses. Right-click for actions; on a folder, Get
  latest, Check in, or Show in File Explorer.
- **Sign-in and workspace:** set once. The workspace is `C:\CVC` on every computer, so
  assembly references resolve for everyone.

The tab keeps up with the vault by itself, every 20 seconds and after anything you do.

While you work:
- **Start editing a file you haven't checked out** and Vault offers to check it out.
  Saving such a file also offers a check-out first, then saves it in place, or explains
  why it can't be saved (someone else has it, or there's a newer version) and offers to
  save your changes under another name.
- **Check in an assembly** and the new parts it uses, and the parts you changed, go
  into the same check-in. Each is recorded with the version it used, and SolidWorks
  is asked what the assembly references.
- **Getting the latest version** of an open file updates it in place, along with the
  parts it uses; an open assembly that uses an updated part updates too. Files with
  unsaved changes are never replaced for you.
- **Take over** a check-out from another computer: your own (you checked it out on the
  lab PC), or, if you're a lead of the folder or an admin, someone else's. Their changes
  stay on their computer, and Vault tells them who took it over if they try to check in.
- **Open in SolidWorks** from the web app: Vault gets the latest version, and the parts it
  uses, and opens it here. If SolidWorks isn't running, it starts first. (This is
  `cvc-open.exe`, which setup registers for `cvc:` links.)
- **New part, New assembly, New drawing** from the web app: SolidWorks makes it here from
  your default template (a drawing with a view of its part or assembly), saves it in the
  workspace, and checks it in at once, checked out to you. Everyone sees it's there and
  yours; design it, then check it in.

## Install

1. In the Vault web app, open **SolidWorks** (at the top) and download `Vault-Setup.exe`.
   (It's the `vault-setup` artifact of a CI run; an admin puts it in the server's
   `CVC_DOWNLOADS_DIR`.)
2. Close SolidWorks and run it. It isn't signed yet: if Windows says it protected your PC,
   click **More info**, then **Run anyway**. It asks for administrator rights, then installs
   the add-in in `C:\Program Files\Vault for SolidWorks`. Running a newer one updates it.
3. Back on the web app's SolidWorks page, click **Connect SolidWorks**. SolidWorks starts
   with the Vault tab open, and your browser asks you to confirm. (Or type the web app's
   address into the Vault tab yourself, and sign in.)

If the Vault tab doesn't appear, check **Tools > Add-ins** and tick Vault (both boxes, so it
loads at startup). To remove the add-in, remove **Vault for SolidWorks** in Windows'
Settings > Apps > Installed apps; your workspace and sign-in stay.

By hand (for development): build it (`dotnet build -c Release client/src/Cvc.SolidWorks`,
output in `bin/Release/net48`, or the `cvc-solidworks-addin` artifact), put the folder
somewhere permanent, and run `powershell -ExecutionPolicy Bypass -File install.ps1` in it,
as administrator (`uninstall.ps1` removes it). To update, close SolidWorks and replace the
folder's files.

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

1. After installing, SolidWorks starts with the Vault tab, and `addin.log` says the add-in
   started.
2. Sign in: your browser opens, you confirm, and the tab shows your name and
   `C:\CVC`.
3. Save a new part into `C:\CVC\Test`. The tab says "New". Check it in with a comment,
   and the part turns read-only in SolidWorks.
4. Start editing it. Vault offers a check-out; accept, save, and check in: it's now v2.
5. As a second person (another PC, or `cvc checkout` as someone else), check the part
   out. The first PC shows who has it. Change the part there and save: Vault says who has
   it, and offers to save your changes under another name.
6. Make an assembly from a new part and an existing part, then check in the assembly.
   The new part goes in too, and `cvc history` on the assembly lists both references
   with their versions.
7. With a newer version checked in elsewhere, click Get latest on the open file. It
   updates in place, without closing.
8. Undo a check-out that has changes. The file goes back to the vault's version, and
   your copy is in `C:\CVC\.cvc\backup`. Do it again with the file saved just before the
   undo, and with an open assembly that uses the file: both work the same way.
9. On a display scaled above 100% (most laptops; Settings > System > Display > Scale),
   the Vault tab and the Check in dialog look as they do at 100%, only larger: no text is
   cut off, and the comment box is full size.
10. Create a new part, save it into `C:\CVC\Test`, and check it in. Without switching
    windows, start editing it: Vault offers the check-out.
11. Change a checked-in file, answer No when Vault offers the check-out, then save
    (Ctrl+S). Vault offers the check-out again; Yes saves the file in place, with no Save
    As dialog.
12. As an admin (or a lead of the folder), open a file someone else has checked out: the
    tab offers Take over. Take it over; it's checked out to you. When they try to check it
    in (`cvc checkin` as them), Vault says you took it over. Someone who isn't a lead doesn't
    see Take over.
13. In the web app, click Open in SolidWorks on an assembly that isn't downloaded here:
    SolidWorks comes to the front with it open, and its parts were downloaded too. Close
    SolidWorks and do it again: SolidWorks starts, then opens it.
14. On the Browse tab, open folders down to an assembly, then open the assembly: its parts
    are listed, each checked in or not, and a part with a drawing lists it. Check one of
    the parts out as someone else (`cvc checkout`): within 20 seconds its line says who
    has it, and the tree stays open where it was. Double-click a file that isn't
    downloaded here: it's downloaded, and opens. With a part that has a drawing active,
    Open drawing opens the drawing.
15. In the web app, in a folder, click New part, name it, and Start it in SolidWorks: a new
    part opens in SolidWorks, and within seconds the web app lists it as v1, checked out
    to you. On a part's page, click New drawing: a drawing named after the part opens,
    with a view of it, and the part's page lists the drawing.
16. On a PC without the add-in, download Vault-Setup.exe from the web app's SolidWorks page
    and run it: after Windows' warnings, it installs. Click Connect SolidWorks: SolidWorks
    starts with the Vault tab, the browser asks to confirm, and the tab shows your name.
    Click it again: the tab says it's connected already. Remove Vault for SolidWorks in
    Settings > Apps: SolidWorks starts without it, and `C:\Program Files\Vault for
    SolidWorks` is gone.

## When something goes wrong

The add-in logs to `%LOCALAPPDATA%\CVC\addin.log`. Settings are in
`%APPDATA%\CVC\addin.json`, and saved sign-ins (encrypted) are in
`%APPDATA%\CVC\tokens.json`. The `cvc` CLI uses the same workspace and sign-in, so
`cvc status` in `C:\CVC` is a good second opinion.
