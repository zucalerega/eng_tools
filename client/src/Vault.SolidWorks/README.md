# Vault add-in for SolidWorks 2026

Check files in and out without leaving SolidWorks. The add-in is for SolidWorks 2026, the
team's version: files saved in 2026 don't open in older versions, so everyone works in one.
It runs in SolidWorks 2025 too, so laptops that had it there keep getting updates while they
move over. It adds a **Vault** tab to the task pane with these parts:

- **The header:** Vault's mark, **Update** when there's a newer add-in (see "Updates"), a
  refresh button, and your name. Click your name for your account, the vault's address,
  the workspace folder, and the add-in's version, to open the web app or the workspace
  folder, or to sign out.
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
  aren't. Right-click for actions: on a part or assembly, Insert into the assembly you
  have open (see "While you work"); on a folder, Get latest, Check in, Free up space, or
  Show in File Explorer.
- **Update downloaded files**, **Download everything...**, and **Free up space...**, under
  the files (see "Getting files" and "Freeing up space").
- **Sign-in and workspace:** set once. The workspace is `C:\VLT` on every computer, so
  assembly references resolve for everyone (setup makes it). It has a folder for each of
  the vault's folders, to save new parts in, but only the files you've opened, checked
  out, or got: the rest of the vault stays on the server until you need it.
- **Vault's questions and warnings** come in Vault's own box (`MessageDialog`), not
  Windows': it's never taller than most of the screen, a long one (a list of files) scrolls
  and can be copied, and it takes the keys Windows' does: Enter for the highlighted answer,
  Esc for Cancel (or No, or OK), and Y and N.

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
says so. Nor do they replace an open file with unsaved changes.

### Conflicts

A file you've changed here, when someone has checked in a newer version since, is in
conflict: Vault won't check it in or out until you choose which copy to go on with. Its
card, and its right-click menu in Needs attention or Browse, offer both:

- **Keep mine...** checks your copy out as it is. Checking it in makes it the next version,
  on top of the vault's, which stays in the history.
- **Use the vault's version...** replaces your copy with the latest version. Yours is kept
  in `C:\VLT\.vault\backup` first, and changes you haven't saved in SolidWorks are lost, as
  it says before it starts.

A copy that didn't come from the vault (copied in by hand, or there before Vault was
installed) is in conflict too when it differs from the vault's latest version, and settles
the same way.

### Freeing up space

A file stays on the computer once it's downloaded, so `C:\VLT` grows with everything
you've opened. **Free up space...** (under the files, or on a folder's or a file's
right-click menu) removes the copies on this computer of files that are just as they came
from the vault, at any version, and that aren't checked out to you: nothing is lost. It
says how many files and how much space first, and asks; No is the default. Files you've
changed, new files, your check-outs, and anything open in SolidWorks (with every file it
uses) stay. Freed files show as Not downloaded, and come back when you open or get them,
which needs a connection to the vault: keep what you'll need where there's no internet.
It never happens by itself. `vault free` does the same from the command line.

While you work:
- **Insert a part from the vault** into the assembly you're working on, in one step,
  whether it's on this computer or not: right-click it in Browse (or Needs attention) and
  choose **Insert into** your assembly. Vault gets its latest version, and the parts it
  uses if it's an assembly, and SolidWorks adds it beside the assembly, selected and in
  view: drag it into place and mate it. As with any change, Vault then offers to check
  the assembly out if it isn't yours, and asks first if someone else has it checked out.
  When you check the assembly in, the part is recorded with the version it went in at.
- **Start editing a file you haven't checked out** and Vault offers to check it out (or,
  if it's checked out to you in the web app or on another computer, to move the check-out
  here).
  Saving such a file also offers a check-out first, then saves it in place, or explains
  why it can't be saved (someone else has it, there's a newer version, or it was deleted
  from the vault since you got it: restore it from its folder's trash in the web app) and
  offers to save your changes under another name.
- **Saving an assembly** saves the parts it uses that changed, too, and in SolidWorks 2026
  every part last saved in an older SolidWorks counts as changed. Vault asks about those
  that aren't checked out to you once, not once each: Yes checks them out and saves them;
  No, the default, leaves them as the vault has them, what changed in them still on
  screen. Any it can't save (someone else has it, deleted, out of date) it names.
- **Check in an assembly** and the new parts it uses, and the parts you changed, go
  into the same check-in. Each is recorded with the version it used, and SolidWorks
  is asked what the assembly references. One that uses a file deleted from the vault since
  you got it isn't checked in, and Vault says to restore that file or take it out of the
  assembly. A part's link to a deleted file (the assembly it was edited in, or a part it's
  made from) doesn't keep it out: the part goes in without that link, and the Vault tab
  says so. Before checking in, Vault offers to save your open files that changed: only
  those you can save, checked out to you or new.
- **Getting the latest version** of an open file updates it in place, along with the
  parts it uses; an open assembly that uses an updated part updates too. Files with
  unsaved changes are never replaced for you.
- **Take over** a check-out from another computer: your own (you checked it out on the
  lab PC), or, if you're a lead of the folder or an admin, someone else's. Their changes
  stay on their computer, and Vault tells them who took it over if they try to check in.
- **Open in SolidWorks** from the web app: Vault gets the latest version, and the parts it
  uses, and opens it here. If SolidWorks isn't running, it starts first. (This is
  `vault-open.exe`, which setup registers for the web app's links.) The Vault tab comes to
  the front and says what it's doing; a file that can't be opened gets a message saying
  why (saved in a newer SolidWorks, another file of the same name open, its download
  failed). What goes wrong before the add-in has the link (it isn't on, or it's still busy
  with your last click) is a message on top of SolidWorks from `vault-open.exe`. Both write
  each click, and what became of it, to `addin.log`.
- **Files brought over from Kenesto** (uploaded in the web app) name their parts where
  Kenesto had them (`K:\Yellow Jacket Space Program\Project CAD\09_Hopper\...`), and the
  vault can't read what they use. Opening or getting one reads the parts' paths from the
  file, and from its sub-assemblies, and gets the vault's files whose paths end the same
  way (`09_Hopper\...`), so they come along like any other assembly's parts. So do the
  parts of an assembly saved before their folder was uploaded again under another name and
  the old copies deleted: it still names them in `C:\VLT` (`C:\VLT\09_Hopper\Tanks\...`,
  now `Hopper\Tanks\...`), and Vault gets the vault's file whose path ends the same way,
  with its folder's name the same at least (a copy of the old file still here is what
  SolidWorks opens: Update downloaded files removes those). A STEP (or
  other CAD) file placed with 3D Interconnect is named in the file by the copy SolidWorks
  made of it in its temporary folder (`...\Temp\swx19380\IC~~\BMS.step.SLDASM`), which is
  never on disk: Vault gets the file it was made from (`BMS.step`), and of two with its
  name, the one in the folder most like the assembly's. Parts that aren't in the vault are
  named on the tab (a STEP file by its own name), with their old paths in the log. When
  SolidWorks can't find a part, Vault points it at the vault's copy, found the same way (or,
  for a path from elsewhere, by its name, when only one file in the vault has it).
  Checking in an assembly that still uses files the vault doesn't have lists them all, and
  checks nothing in.
- **New part, New assembly, New drawing** from the web app: SolidWorks makes it here from
  your default template (a drawing with a view of its part or assembly), saves it in the
  workspace, and checks it in at once, checked out to you. Everyone sees it's there and
  yours; design it, then check it in.
- **3D views for Caliper**, the web app's 3D viewer: checking in a part or an assembly makes
  its 3D view (what SolidWorks shows of it, and for an assembly, where each part is), and
  those of the parts and sub-assemblies it uses that have none made in SolidWorks yet, from
  what SolidWorks has open, in the configurations it shows (Caliper reads a file's other
  configurations from the file, where SolidWorks kept them). One made in SolidWorks takes the
  place of one the server read from the file, as it's exactly what SolidWorks drew. **Make 3D view**, on the tab, does the same for the
  active document: for files brought from Kenesto, or checked in from the web. A part
  changed and not checked in, or with changes not saved, gets none until it is; one loaded
  lightweight needs the assembly set to resolved first. The tab says what it made, and why
  anything wasn't.
- **PDFs of drawings for Caliper**: checking in a drawing saves it as a PDF of all its
  sheets, as File > Save As > PDF does, which Caliper shows in the web app. **Make PDF**, on
  the tab, does the same for the active drawing, where its version has none: for drawings
  from before, brought from Kenesto, or checked in from the web. A drawing changed and not
  checked in, or with changes not saved, gets none until it is.
- **Time in SolidWorks**, for Admin > People: while SolidWorks is in front and you've used
  the computer in the last five minutes, the add-in's requests to the vault say so, and the
  vault counts that time beside the time the web app is open. SolidWorks left open behind
  other windows, or overnight, isn't counted. The vault learns only that, not what you
  have open.

## Install

1. In the Vault web app, open **SolidWorks** (at the top) and download `Vault-Setup.exe`.
   (It comes with each release, on its GitHub release; an admin puts it in the server's
   `YJSP_DOWNLOADS_DIR`, with its signature, `Vault-Setup.exe.sig`, for Update.)
2. Close SolidWorks and run it. It isn't signed for Windows yet: if Windows says it
   protected your PC, click **More info**, then **Run anyway**. It asks for administrator
   rights, then installs the add-in in `C:\Program Files\Vault for SolidWorks`. It installs
   the add-in new only where SolidWorks 2026 is; where the add-in is already, on 2026 or
   2025, it updates it, and the add-in keeps your settings, sign-in, and workspace.
3. Back on the web app's SolidWorks page, click **Connect SolidWorks**. SolidWorks starts
   with the Vault tab open, and asks whether to connect to the vault at the address it
   shows: say Yes if it's the one you open Vault at in your browser. Then your browser asks
   you to confirm. (Or type the web app's address into the Vault tab yourself, and sign in.)
   SolidWorks asks only the first time, and for a vault it isn't set up for: any web page
   can make a Connect link, and a server that isn't your team's would get your sign-in.

If the Vault tab doesn't appear, check **Tools > Add-ins** and tick Vault (both boxes, so it
loads at startup). To remove the add-in, remove **Vault for SolidWorks** in Windows'
Settings > Apps > Installed apps; your workspace and sign-in stay.

By hand (for development): build it (`dotnet build -c Release client/src/Vault.SolidWorks`,
output in `bin/Release/net48`, or the `vault-solidworks-addin` artifact of a CI run on
`main`, kept 3 days), put the folder somewhere permanent, and run
`powershell -ExecutionPolicy Bypass -File install.ps1` in it, as administrator
(`uninstall.ps1` removes it). To update, close SolidWorks and replace the folder's files.

## Updates

When the server offers a newer add-in, **Update** appears at the top of the Vault tab (the
add-in looks every few hours). Click it and say Yes: Vault downloads the new
`Vault-Setup.exe` and checks it before it starts it:

- its size and SHA-256 are the ones the server offered it with;
- it's signed with the key Vault's releases are signed with: its signature,
  `Vault-Setup.exe.sig`, which the server has beside it, matches the public key this
  add-in carries. Only CI has the private key, and signs only builds of `main` and release
  tags, so neither the server nor anyone who gets into it can put a program of their own
  on your computer this way (docs/deploying.md, "Signing key");
- it's the version it was offered as, so an older release can't pass for a newer one.

If anything is amiss, nothing starts: the tab says why (no signature, a signature that
doesn't match, a version that isn't the one offered), and so does `addin.log`. Otherwise
Windows asks to let setup make changes, then setup waits: save your work and close
SolidWorks, and it finishes the update. Start SolidWorks again, and the Vault tab is the new
version. Your sign-in, settings, and workspace stay.

An admin offers an update by putting the new `Vault-Setup.exe` and its
`Vault-Setup.exe.sig` (both on a release's GitHub release, or in the `vault-setup` artifact
of a CI run on `main`) in the server's `YJSP_DOWNLOADS_DIR` (see docs/deploying.md, "New
downloads"): the server reads the version from the program. Add-ins from before Update
(0.4.0 and older) don't have the button: run the new `Vault-Setup.exe` once, by hand, from
the web app's SolidWorks page. Add-ins up to 0.5.2 update without checking the signature:
the check starts with the update after that.

## Testing against a development server

A dev server on another computer can serve a Windows PC on the same network:

```
cd server && YJSP_DEV_AUTH=1 YJSP_BOOTSTRAP_ADMINS=you@example.com YJSP_HOST=0.0.0.0 uv run yjsp-server
```

In the add-in, use `http://<that computer's IP address>:8000` as the server, and sign in with
the development form as `you@example.com`.

## Manual checks before a release

The add-in can't be tested automatically (that would need SolidWorks), so run through
these on SolidWorks 2026, and 22 to 24 on 2025 as well:

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
   size. The tab fills the task pane from top to bottom, and follows it when you drag the
   task pane's edge or undock it.
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
    starts with the Vault tab and asks whether to connect to the vault, showing its address
    (No is chosen to start with); say Yes, the browser asks to confirm, and the tab shows
    your name. Click it again: the tab says it's connected already. Sign out, and click it
    again: it signs in without asking which vault. Remove Vault for SolidWorks in
    Settings > Apps: SolidWorks starts without it, and `C:\Program Files\Vault for
    SolidWorks` is gone.
17. With a part and an assembly downloaded here, and newer versions of both checked in
    elsewhere (the assembly now using a new part), click Update downloaded files: both
    update, the new part comes down, and nothing else does. Click Download everything...: it
    says how many files and how big, and No downloads nothing; No is chosen to start with,
    so Enter downloads nothing either. Right-click a folder that isn't here in Browse and
    choose Get latest: it asks first too.
18. Upload a folder from Kenesto in the web app, keeping its folders (an assembly with parts
    in the same folder and in subfolders, and a sub-assembly with parts of its own), leaving
    one of the sub-assembly's parts out. On the Browse tab, double-click the assembly: its
    parts and the sub-assembly's come down, it opens with them, and the tab names the part
    left out. Close it, delete a part from `C:\VLT`, and double-click the assembly again: that
    part comes back, and nothing else downloads. Close it, and delete the sub-assembly's
    parts from `C:\VLT`, keeping the sub-assembly and the assembly's own parts: double-click
    the assembly, and they come back before it opens, with no part grey or ⚠, and the tab
    names the part left out again. Close it, delete them again, click Refresh, and at once
    double-click the assembly: it waits for the refresh, then does the same.
19. Watch the card as a part changes state. Up to date: Check out (in navy) and Get
    latest. Checked out to you: Check in (in navy) and Undo check-out. Out of date: Get
    latest first. Checked out by someone else: who, on which computer, and since when, and
    no button for what you can't do. While Vault works, the bar under the header runs and
    the buttons gray out; each button's tooltip says what it does. Needs attention lists
    only files on this computer and your check-outs, and says so when it's empty.
20. Click your name in the header: Open the web app opens the vault in your browser, Open
    the workspace folder opens `C:\VLT`, and Sign out signs you out.
21. Open an assembly that's checked in. In Browse, right-click a part that isn't downloaded
    here and choose Insert into (the assembly): it downloads, appears beside the assembly,
    selected, and Vault offers to check the assembly out. Mate it, save, and check the
    assembly in: `vault history` on it lists the part with its version. Do it again with a
    sub-assembly that isn't here: its parts come down too, and it goes in whole. With a part
    active instead, the menu says to open an assembly first; a drawing has no Insert.
22. On a PC with SolidWorks 2025 and no add-in, run Vault-Setup.exe: it says it needs
    SolidWorks 2026, and installs nothing. On a PC with SolidWorks 2025 and an older add-in,
    it offers Update, and updates it; SolidWorks 2025 starts with the new Vault tab, and
    `addin.log` says which SolidWorks it started in.
23. Put a Vault-Setup.exe with a newer version than the installed add-in, and its
    Vault-Setup.exe.sig (from a release, or CI's `vault-setup` artifact from `main`), in the
    server's downloads folder, then start SolidWorks: Update appears in the tab's header,
    and the web app's SolidWorks page shows the new version, and doesn't list the
    signature. Click Update and say Yes, but No to
    Windows' question: the tab says the update needs permission, and Update stays. Click
    it again and say Yes to both: setup waits for SolidWorks; close it, and setup updates the
    add-in. Start SolidWorks: your name's menu shows the new version, and there's no Update.
24. Close SolidWorks and click Open in SolidWorks in the web app: SolidWorks starts (2026,
    on a PC with both 2025 and 2026), and opens the file.
25. With an assembly open (its parts came with it), a part checked out to you, and a part
    you've changed, click Free up space...: it says how many files and how much space, and
    No changes nothing. Yes: the assembly and its parts, your check-out, and the changed
    part stay; everything else here turns Not downloaded in Browse and is gone from
    `C:\VLT`. Double-click a freed part: it downloads and opens. Right-click a folder and
    choose Free up space: only that folder's copies go.
26. Caliper, a part: make a part with a hole, a fillet, a countersink, and one face colored
    red (Appearance on the face), in inches. Check it in: the tab says it made a 3D view. In
    the web app, Open in Caliper shows it in its colors, red face and all, with its edges,
    and measures in inches. Measure the hole, the countersink, and the distance between two
    faces: the same as SolidWorks' Measure gives.
27. Caliper, an assembly: put that part in an assembly twice, the second turned 90° and
    moved, with a sub-assembly of two other parts, a virtual part, and a component colored
    blue in the assembly (its appearance there). Hide one component, then check the
    assembly in. In Caliper, every component is where SolidWorks has it (compare the front,
    top, and isometric views), the blue one blue, the hidden one unticked in the tree and
    not drawn, the virtual part there. Open the sub-assembly from the tree: it shows on its
    own. Cut it with a section: what SolidWorks' section view shows.
28. Configurations: use two configurations of one part in an assembly and check it in:
    Caliper shows each configuration's shape, and the part's page offers both.
29. Make 3D view: open an assembly uploaded from the web (it has no 3D view), resolve it
    if it opened lightweight, and click Make 3D view: the tab says how many 3D views it
    made, and Caliper shows the assembly. Click it again: it says it has them already.
    Change a part without saving, open another assembly that uses it, and click Make 3D
    view: the tab says that part's wasn't made, and why.
30. Conflicts: with a part downloaded here, make it writable in File Explorer (Properties,
    untick Read-only), change it in SolidWorks and save, while someone else checks in a
    new version of it. Refresh: the card says Conflict, with Keep mine... and Use the
    vault's version... and no Get latest. Keep mine: it's checked out to you with your
    change; check it in, and its history has your version on top of theirs. Make another
    conflict and choose Use the vault's version, with an unsaved change open: the
    question says that change is lost; Yes, and the part shows their version, read-only,
    with yours in `C:\VLT\.vault\backup`. Both are on the right-click menu in Needs
    attention too.
31. Links for another vault: sign out, then open
    `vault://connect?server=https%3A%2F%2Fvault.example.org` (Windows' Run box, Win+R):
    SolidWorks asks whether to connect to `https://vault.example.org`, says it's set up for
    the team's vault, and has No chosen. No: nothing opens in the browser, and the tab says it
    didn't connect. Open `vault://open?server=https%3A%2F%2Fvault.example.org&path=A.SLDPRT`:
    it says SolidWorks isn't connected to that vault, and the server box still shows the
    team's. Sign in again, and open the connect link once more: it says SolidWorks is
    connected to the team's vault, and to sign out to switch.
32. Updates that aren't signed: with a newer signed build in the downloads folder (as in
    23), take its Vault-Setup.exe.sig out, and restart SolidWorks. Click Update and say
    Yes: the tab says it has no signature, so Vault won't install it, Windows asks nothing,
    and `addin.log` has a line saying why. Put another build's Vault-Setup.exe.sig in its
    place, and click Update again: it says it isn't signed with the key Vault's releases are
    signed with. Put its own back: the update goes ahead, as in 23.
33. Time in SolidWorks: with SolidWorks in front, work in it for three minutes, then leave it
    behind another window for three minutes. In the web app, Admin > People: hovering your
    Time on site says about three minutes in SolidWorks (it's counted a minute at a time, so
    give or take one), and today's column in the Activity chart's Time on the site has it on
    top, in SolidWorks' color. Then leave the computer alone, SolidWorks in front, for fifteen
    minutes: about five more count (until it's been five minutes without a key or the mouse),
    and no more.
34. Open in SolidWorks when it can't: with the Design Library tab in front of the task pane,
    click Open in SolidWorks on a part: the Vault tab comes to the front, says it's opening
    it, and the part opens. In SolidWorks 2025, open a part saved in 2026: a message says
    it was saved in a newer SolidWorks. With a `Bracket.SLDPRT` open, open another
    `Bracket.SLDPRT` from a different folder: the message names the open one. Make a folder
    where a file's download goes (`C:\VLT\Test\Fin.SLDPRT` as a folder) and open that file:
    the message says it can't be put there, not that it isn't in the vault. Open a big
    assembly that isn't here, and while it downloads click Open in SolidWorks on another
    file: a message says Vault is still busy with a link you clicked before. Untick both of
    Vault's boxes in Tools > Add-ins and restart SolidWorks, then click Open in SolidWorks:
    within 10 seconds a message on top of SolidWorks says to tick Vault's boxes. Close
    SolidWorks and click it again: SolidWorks starts, and after 3 minutes the same message is
    on top of it, not behind. Tick them again, close SolidWorks, start it yourself, and click
    Open in SolidWorks at once: no message about the add-in, and the file opens once
    SolidWorks is up. `addin.log` has a line for each click, from `vault-open.exe` and from
    the add-in, saying what became of it. Open a link for another vault
    (`vault://open?server=https%3A%2F%2Fvault.example.org&path=A.SLDPRT` in Win+R): the
    message says which vault SolidWorks is connected to, and how to switch.
35. 3D Interconnect: in an assembly in a folder of its own, insert a STEP file of a board with
    several parts (Insert Components, with 3D Interconnect on, its default) from a subfolder,
    save, and upload the folder from the web app as from Kenesto, with another STEP file of
    the same name in a different top folder. On another PC (or after Free up space), open the
    assembly from the Browse tab: the STEP file from the assembly's own folder comes down
    with it, not the other, and the board shows, with no ⚠ and no note naming
    `<name>.step.SLDASM`. Delete the STEP file from `C:\VLT` and open the assembly again: it
    comes back. Delete both STEP files in the web app and open the assembly: the tab names
    the STEP file, as `<name>.step`. In the web app, Caliper shows the board, drawn
    from the STEP file. Then check the assembly out and check it in from SolidWorks, and
    write down what happens: if the check-in refuses the STEP file's copy in SolidWorks'
    temporary folder (`...\IC~~\...`), that's still to fix.
36. Titles: in the web app, give a test part a title (Edit title… on its page). Within 20
    seconds Browse shows it after the part's name, in quotes, and with the part open, the card
    shows it under the name. Right-click the part in Browse > Edit title…, change it, and
    Save: the web app shows the new one, and the part is still at the same version.
37. New part in Browse: with part numbers offered (the web app's Admin > Part numbers), right-click
    a test folder in Browse > New part…: pick a kind, give a title, and Start it. SolidWorks
    makes `<number>.SLDPRT` in that folder from your default template, it's in the vault as
    version 1, checked out to you, and the web app shows its title. With part numbers off, New
    part… says they aren't handed out yet. Do the same with New assembly….
38. Vendors' parts: save a new part as `91251A463_Socket Head Screw.SLDPRT` and another as
    `Bearing.SLDPRT`, and check both in at once. The Check in dialog offers to mark the new parts
    without part numbers as vendors' (unticked, as `Bearing` isn't named by McMaster's numbers);
    tick it and check in. In the web app, both files' pages say "Vendor's part".
39. A part renamed since: upload an assembly and its part from the web app as from Kenesto,
    get the assembly in SolidWorks, close it, and rename the part in the web app (Fin.SLDPRT to
    Fin left.SLDPRT). After a refresh, open the assembly: the part is there, with no missing
    reference: Vault points SolidWorks at the renamed file, by the name it had.
40. Pause: in the web app, Admin > Part numbers > Pause the vault, for "testing". Within 20
    seconds the Vault tab says who paused it and why, and checking a file out says the vault is
    paused. Unpause in the web app: the notice goes, and the check-out works.
41. Drawings' PDFs: make a drawing of a part with two sheets (a second sheet with a detail
    view and a note), dimensions, a hole callout (⌀), and a GD&T frame, and check it in: the
    tab says it made the PDF Caliper shows, and no PDF window opens. In the web app, Open in
    Caliper shows both sheets in the browser's PDF viewer, as SolidWorks prints them, the
    callout and the GD&T frame as SolidWorks draws them; Open PDF shows it in a tab of its
    own. Open a drawing checked in from the web (or before this release) and click Make PDF:
    the same; click it again: it says it has its PDF already. Change the drawing without
    saving and click Make PDF: it says why it didn't. Check `%TEMP%` has no `vault-*.pdf`
    left.
42. Long messages: open an assembly of many parts saved in an older SolidWorks (so they all
    count as changed), check the assembly out, and save it: Vault's question about the
    parts it saves along lists them in Vault's box, which stops short of the screen's bottom
    with its buttons showing, and scrolls. It moves by its title bar; Y, N, Esc, and Enter
    answer it as in Windows' message box. A short warning (save a file someone else has
    checked out) is only as tall as its text. At 150% and 250% display scaling it looks the
    same.
43. Saving along: in the same assembly, have someone else check out one of the parts. Save
    the assembly: Vault asks once, lists the parts, names the one someone else has, and has
    No chosen to start with. Answer No: the assembly saves, the parts don't (SolidWorks still
    shows them changed), and nothing else asks. Save again and answer Yes: the parts but the
    other person's are checked out to you and saved. Click Check in: "Save changes before
    checking in?" lists only files checked out to you or new, if any changed.
44. Uploaded again: check in from SolidWorks an assembly in a folder `Old`, with parts in a
    subfolder `Old\Parts` and one beside it. Save it as `New\A.SLDASM` (still using `Old`'s
    parts), upload `Old\Parts` and the other part into `New` in the web app, check
    `New\A.SLDASM` in, and delete `Old` (Delete anyway). On another PC (or after Free up
    space), open `New\A.SLDASM` from the Browse tab: the parts from `New\Parts` come down and
    it opens with them, none grey or ⚠; the tab names the part beside it, which only its name
    ties to its copy. With a copy of `Old` still on that PC, SolidWorks opens those: Update
    downloaded files removes them, and then it opens with `New`'s.

## When something goes wrong

Open in SolidWorks did nothing at all: the add-in isn't installed on that computer (run
Vault-Setup.exe), or the browser's question about opening `vault-open.exe` was turned down;
`reg query HKLM\SOFTWARE\Classes\vault\shell\open\command` shows whether links are
registered. Anything after that is in the log, a line for each click.

The add-in logs to `%LOCALAPPDATA%\Vault\addin.log`. Settings are in
`%APPDATA%\Vault\addin.json`, and saved sign-ins (encrypted) are in
`%APPDATA%\Vault\tokens.json`. The `vault` CLI uses the same workspace and sign-in, so
`vault status` in `C:\VLT` is a good second opinion.
