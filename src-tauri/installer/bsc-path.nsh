; base-studio-code — optional "bsc on PATH" installer step (#2734).
;
; Tauri v2 NSIS installer hooks (bundle.windows.nsis.installerHooks). On install, OFFER — opt-in, a
; Yes/No prompt, never silent (`/SD IDNO` makes an unattended `/S` install DECLINE) — to add the app's
; install dir to the USER PATH so the bundled `bsc` runs from any terminal. On uninstall, remove it.
;
; The actual environment edit is delegated to PowerShell
; (`[Environment]::SetEnvironmentVariable(..,'User')`), which writes HKCU\Environment AND broadcasts the
; change — so there's no fragile NSIS registry / StrFunc / WM_SETTINGCHANGE bookkeeping to get wrong.
; User scope only: no elevation, no system-wide PATH. This mirrors the in-app "Add to PATH" banner
; (#2734) — the banner stays the primary surface; this is a convenience at install time.
;
; Uses only NSIS core (MessageBox + the built-in nsExec plugin) + PowerShell (present on every Windows),
; so it adds no plugin dependency to the bundler. `$$` is a literal `$` (a PowerShell variable); the
; backtick-delimited strings let the PowerShell single/double quotes pass through verbatim.

!macro NSIS_HOOK_POSTINSTALL
  MessageBox MB_YESNO|MB_ICONQUESTION "Add bsc to your PATH?$\n$\nThis lets you run the bundled 'bsc' command from any terminal window. It adds this folder to your user PATH:$\n$\n    $INSTDIR$\n$\n(You can also enable this later from inside the app.)" /SD IDNO IDNO bsc_path_skip
    ; Append $INSTDIR to the USER Path if it isn't already there (idempotent), then broadcast (PowerShell
    ; does the broadcast). TrimStart handles the empty-Path case; -notContains keeps re-installs clean.
    nsExec::Exec `powershell -NoProfile -NonInteractive -Command "$$p=[Environment]::GetEnvironmentVariable('Path','User'); if($$p -eq $$null){$$p=''}; if(-not $$p.Contains('$INSTDIR')){[Environment]::SetEnvironmentVariable('Path', (($$p.TrimEnd(';')+';$INSTDIR').TrimStart(';')), 'User')}"`
    Pop $R0 ; discard the exit code (best-effort — a PATH tweak never blocks the install)
  bsc_path_skip:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Remove exactly our $INSTDIR entry from the USER Path (split, drop it + blanks, rejoin), then broadcast.
  nsExec::Exec `powershell -NoProfile -NonInteractive -Command "$$p=[Environment]::GetEnvironmentVariable('Path','User'); if($$p){$$n=(($$p -split ';') | Where-Object { $$_ -and ($$_ -ne '$INSTDIR') }) -join ';'; [Environment]::SetEnvironmentVariable('Path', $$n, 'User')}"`
  Pop $R0
!macroend
