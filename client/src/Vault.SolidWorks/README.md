# Vault add-in for SolidWorks 2025

Check files in and out without leaving SolidWorks. The add-in adds a **Vault** tab to the
task pane with these parts:

- **The header:** Vault's mark, a refresh button, and your name. Click your name for your
  account, the vault's address, and the workspace folder, to open the web app or the
  workspace folder, or to sign out.
- **The active document's card:** what state the file is in (up to date, checked out to
  you, out of date, checked out by someone else, new, ...), what that means, and buttons
  for only what you can do with it now, the likeliest first, in navy: Check in, Check
  out, Get latest, Undo check-out, Take over (Move check-out here, for your own check-out
  on another computer), and Open drawing when it has one. Hover over a button for what it
  does.
- **Needs attention:** the files on this computer that need you: your check-outs, new
  files, files that changed or are out of date, conflicts, files deleted in the vault, and
  files here that someone else has checked out. Each has a colored dot, and its folder.
  Right-click for actions; double-click, or Enter, to open.
- **Browse:** the whole vault as a tree, folder by folder. Every file says whether it's
  here and up to date, or who has it checked out and where; every folder how many of its
  files are checked out. Assemblies open up to show their parts and sub-assemblies (with
  the version each was checked in with), and parts and assemblies list their drawings.
  Hover for where a file is used. Double-click to open: a file that isn't here yet is
  downloaded first, with the parts it uses, and one that is gets the parts it uses that
  aren't. Right-click for actions; on a folder, Get latest, Check in, or Show in File
  Explorer.
- **Update downloaded files** and **Download everything...**, under the files (see
  "Getting files").
- **Sign-in and workspace:** set once. The workspace is `C:\VLT` on every computer, so
  assembly references resolve for everyone (setup makes it). It has a folder for each of
  the vault's folders, to save new parts in, but only the files you've opened, checked
  out, or got: the rest of the vault stays on the server until you need it.

The tab keeps up with the vault by itself, every 20 seconds and after anything you do. A
thin bar under the header runs while Vault is working, and the line at the bottom says
how the last thing went.

### Getting files

| Button | What it downloads |
|---|---|
| **Get latest**, on the card or a file's right-click menu | The newest version of that file, and of every part and sub-assembly it uses. Open files update in place. |
| **Get latest**, on a folder's right-click menu in Browse | The newest version of every file in the folder and the folders in it. If that's files you don't have yet, it says how many and how big, and asks first. |
| **Update downloaded files** | The newest version of every vault file already on this computer, and parts they've started to use. Nothing else. |
| **Download everything...** | Every file in the vault you have access to. It says how many files that is, how big, and how much room the drive has, and asks first; No is the default, so Enter doesn't start it. |

None of them replace a file you've changed here: it's skipped, and the line at the bottom
says so (the CLI's `vault get --force` replaces it, keeping a copy). Nor do they replace an
open file with unsaved changes.

While you work:
- **Start editing a file you haven't checked out** and Vault offers to check it out (or,
  if it's checked out to you in the web app or on another computer, to move the check-out
  here).
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
  `vault-open.exe`, which setup registers for the web app's links.)
- **Files brought over from Kenesto** (uploaded in the web app) name their parts where
  Kenesto had them (`K:\Yellow Jacket Space Program\Project CAD\09_Hopper\...`), and the
  vault can't read what they use. Opening or getting one reads the parts' paths from the
  file and gets the vault's files whose paths end the same way (`09_Hopper\...`), so they
  come along like any other assembly's parts; parts that aren't in the vault are named on
  the tab, with their old paths in the log. When SolidWorks can't find a part, Vault
  points it at the vault's copy, found the same way (or by its name, when only one file in
  the vault has it). Checking in an assembly that still uses files the vault doesn't have
  lists them all, and checks nothing in.
- **New part, New assembly, New drawing** from the web app: SolidWorks makes it here from
  your default template (a drawing with a view of its part or assembly), saves it in the
  workspace, and checks it in at once, checked out to you. Everyone sees it's there and
  yours; design it, then check it in.

## Install

1. In the Vault web app, open **SolidWorks** (at the top) and download `Vault-Setup.exe`.
   (It's the `vault-setup` artifact of a CI run; an admin puts it in the server's
   `YJSP_DOWNLOADS_DIR`.)
2. Close SolidWorks and run it. It isn't signed yet: if Windows says it protected your PC,
   click **More info**, then **Run anyway**. It asks for administrator rights, then installs
   the add-in in `C:\Program Files\Vault for SolidWorks`. Running a newer one updates it,
   and the add-in keeps your settings, sign-in, and workspace.
3. Back on the web app's SolidWorks page, click **Connect SolidWorks**. SolidWorks starts
   with the Vault tab open, and your browser asks you to confirm. (Or type the web app's
   address into the Vault tab yourself, and sign in.)

If the Vault tab doesn't appear, check **Tools > Add-ins** and tick Vault (both boxes, so it
loads at startup). To remove the add-in, remove **Vault for SolidWorks** in Windows'
Settings > Apps > Installed apps; your workspace and sign-in stay.

By hand (for development): build it (`dotnet build -c Release client/src/Vault.SolidWorks`,
output in `bin/Release/net48`, or the `vault-solidworks-addin` artifact), put the folder
somewhere permanent, and run `powershell -ExecutionPolicy Bypass -File install.ps1` in it,
as administrator (`uninstall.ps1` removes it). To update, close SolidWorks and replace the
folder's files.

## Testing against a development server

A dev server on another computer can serve a Windows PC on the same network:

```
cd server && YJSP_DEV_AUTH=1 YJSP_BOOTSTRAP_ADMINS=you@example.com YJSP_HOST=0.0.0.0 uv run yjsp-server
```

In the add-in, use `http://<that computer's IP address>:8000` as the server, and sign in with
the development form as `you@example.com`.

## Manual checks before a release

The add-in can't be tested automatically (that would need SolidWorks), so run through
these on SolidWorks 2025:

1. After installing, SolidWorks starts with the Vault tab, and `addin.log` says the add-in
   started.
2. Sign in: your browser opens, you confirm, and the header shows your name. Click it: the
   menu shows the vault's address and `C:\VLT`.
3. Save a new part into `C:\VLT\Test`. The card says "New". Check it in with a comment,
   and the part turns read-only in SolidWorks.
4. Start editing it. Vault offers a check-out; accept, save, and check in: it's now v2.
5. As a second person (another PC, or `vault checkout` as someone else), check the part
   out. The first PC shows who has it. Change the part there and save: Vault says who has
   it, and offers to save your changes under another name.
6. Make an assembly from a new part and an existing part, then check in the assembly.
   The new part goes in too, and `vault history` on the assembly lists both references
   with their versions.
7. With a newer version checked in elsewhere, click Get latest on the open file. It
   updates in place, without closing.
8. Undo a check-out that has changes. The file goes back to the vault's version, and
   your copy is in `C:\VLT\.vault\backup`. Do it again with the file saved just before the
   undo, and with an open assembly that uses the file: both work the same way.
9. On a display scaled above 100% (most laptops; Settings > System > Display > Scale),
   the Vault tab and the Check in dialog look as they do at 100%, only larger: no text is
   cut off, the dots, folders, and the card's badge are sharp, and the comment box is full
   size.
10. Create a new part, save it into `C:\VLT\Test`, and check it in. Without switching
    windows, start editing it: Vault offers the check-out.
11. Change a checked-in file, answer No when Vault offers the check-out, then save
    (Ctrl+S). Vault offers the check-out again; Yes saves the file in place, with no Save
    As dialog.
12. As an admin (or a lead of the folder), open a file someone else has checked out: the
    card offers Take over. Take it over; it's checked out to you. When they try to check it
    in (`vault checkin` as them), Vault says you took it over. Someone who isn't a lead doesn't
    see Take over.
13. In the web app, click Open in SolidWorks on an assembly that isn't downloaded here:
    SolidWorks comes to the front with it open, and its parts were downloaded too. Close
    SolidWorks and do it again: SolidWorks starts, then opens it.
14. On the Browse tab, open folders down to an assembly, then open the assembly: its parts
    are listed, each checked in or not, and a part with a drawing lists it. Check one of
    the parts out as someone else (`vault checkout`): within 20 seconds its line says who
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
17. With a part and an assembly downloaded here, and newer versions of both checked in
    elsewhere (the assembly now using a new part), click Update downloaded files: both
    update, the new part comes down, and nothing else does. Click Download everything...: it
    says how many files and how big, and No downloads nothing; No is chosen to start with,
    so Enter downloads nothing either. Right-click a folder that isn't here in Browse and
    choose Get latest: it asks first too.
18. Upload a folder from Kenesto in the web app, keeping its folders (an assembly with parts
    in the same folder and in subfolders, and a sub-assembly), leaving one part out. On the
    Browse tab, double-click the assembly: its parts come down, it opens with them, and the
    tab names the part left out. Close it, delete a part from `C:\VLT`, and double-click the
    assembly again: that part comes back, and nothing else downloads.
19. Watch the card as a part changes state. Up to date: Check out (in navy) and Get
    latest. Checked out to you: Check in (in navy) and Undo check-out. Out of date: Get
    latest first. Checked out by someone else: who, on which computer, and since when, and
    no button for what you can't do. While Vault works, the bar under the header runs and
    the buttons gray out; each button's tooltip says what it does. Needs attention lists
    only files on this computer and your check-outs, and says so when it's empty.
20. Click your name in the header: Open the web app opens the vault in your browser, Open
    the workspace folder opens `C:\VLT`, and Sign out signs you out.

## When something goes wrong

The add-in logs to `%LOCALAPPDATA%\Vault\addin.log`. Settings are in
`%APPDATA%\Vault\addin.json`, and saved sign-ins (encrypted) are in
`%APPDATA%\Vault\tokens.json`. The `vault` CLI uses the same workspace and sign-in, so
`vault status` in `C:\VLT` is a good second opinion.
