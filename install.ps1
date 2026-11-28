# agentarium installer for Windows (PowerShell 5.1 or 7+).
#
#   irm https://raw.githubusercontent.com/andrew44/agentarium/main/install.ps1 | iex
#
# Downloads agentarium to %USERPROFILE%\.agentarium\app (no git needed), then sets up whichever
# assistants it finds: the Claude Code / Copilot CLI plugin (skills + hooks), the status line, and a
# `agentarium` command. It never replaces a status line you already have. Safe to run again: it
# repairs the app and leaves your recorded data and settings as they are.
#
# agentarium is TypeScript run directly by Node.js 22.18 or newer (no build step, no npm install).
# No Node.js, or an older one? It downloads a private copy into %USERPROFILE%\.agentarium\runtime
# (no admin rights, no installer windows, nothing else on your system changes).
#
# Environment: AGENTARIUM_REPO (default andrew44/agentarium), AGENTARIUM_REF (default main),
#              AGENTARIUM_HOME (default %USERPROFILE%\.agentarium),
#              AGENTARIUM_NODE (a node.exe to use, or "standalone" to always use a private copy),
#              AGENTARIUM_SETUP_ARGS (e.g. "--no-statusline")

& { try {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'           # Invoke-WebRequest is very slow without this
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
    try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

    $repo = if ($env:AGENTARIUM_REPO) { $env:AGENTARIUM_REPO } else { 'andrew44/agentarium' }
    $ref  = if ($env:AGENTARIUM_REF)  { $env:AGENTARIUM_REF }  else { 'main' }
    $tkHome = if ($env:AGENTARIUM_HOME) { $env:AGENTARIUM_HOME } else { Join-Path $HOME '.agentarium' }
    $app = Join-Path $tkHome 'app'
    $runtime = Join-Path $tkHome 'runtime'
    $privateNode = Join-Path $runtime 'node\node.exe'

    function Test-Node([string]$cmd) {
        # Returns the full path of a working Node.js 22.18+, or $null. Every candidate is actually run.
        if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { return $null }
        # No quotes inside the JavaScript: Windows PowerShell 5.1 strips them from native arguments.
        $js = 'const v=process.versions.node.split(String.fromCharCode(46)).map(Number);console.log(v[0]>22||(v[0]==22&&v[1]>=18)?process.execPath:String())'
        try {
            $old = $ErrorActionPreference; $ErrorActionPreference = 'SilentlyContinue'
            $exe = & $cmd -e $js 2>$null | Select-Object -Last 1
        } catch { $exe = $null } finally { $ErrorActionPreference = $old }
        if ($exe -and (Test-Path $exe.Trim())) { return $exe.Trim() }
        return $null
    }

    function Get-PrivateNode {
        # The official Node.js 24 LTS build from nodejs.org, pinned and checked against its
        # published SHA-256. No API calls, so no rate limits.
        $version = 'v24.22.2'
        if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
            $plat = 'win-arm64'; $sum = 'f47968c213105077f64c6510f007632c0ca2574802a0b5067c327c49abe1c468'
        } else {
            $plat = 'win-x64';   $sum = 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2'
        }
        $url = "https://nodejs.org/dist/$version/node-$version-$plat.zip"
        Write-Host 'Downloading a private Node.js for agentarium (one time, about 35 MB)...'
        $zipFile = Join-Path $tmp 'node.zip'
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zipFile
        if ((Get-FileHash -Algorithm SHA256 $zipFile).Hash.ToLower() -ne $sum) {
            Write-Host "The Node.js download didn't match its checksum; not using it."
            return $null
        }
        if (Test-Path $runtime) { Remove-Item $runtime -Recurse -Force }
        New-Item -ItemType Directory -Path $runtime -Force | Out-Null
        Expand-Archive -Path $zipFile -DestinationPath $runtime -Force
        Move-Item (Join-Path $runtime "node-$version-$plat") (Join-Path $runtime 'node')
        return (Test-Node $privateNode)
    }

    function Stop-WithMessage([string]$msg) {
        Write-Host ''
        Write-Host "agentarium: $msg" -ForegroundColor Red
        throw 'agentarium-stop'                          # caught below: no stack trace for users
    }

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("agentarium-" + [guid]::NewGuid())
    $stage = $null
    New-Item -ItemType Directory -Path $tmp, $tkHome -Force | Out-Null
    try {
        # 1. Node.js 22.18+ (built-in modules only; nothing gets npm-installed)
        $node = $null
        if ($env:AGENTARIUM_NODE -and $env:AGENTARIUM_NODE -ne 'standalone') {
            $node = Test-Node $env:AGENTARIUM_NODE
            if (-not $node) { Stop-WithMessage "AGENTARIUM_NODE=$($env:AGENTARIUM_NODE) isn't a working Node.js 22.18+." }
        } elseif (-not $env:AGENTARIUM_NODE) {
            if (Test-Path $privateNode) { $node = Test-Node $privateNode }   # from an earlier install
            if (-not $node) { $node = Test-Node 'node' }
        }
        if (-not $node) {
            try { $node = Get-PrivateNode } catch { $node = $null }
        }
        if (-not $node) {
            Stop-WithMessage 'agentarium needs Node.js 22.18 or newer and could not download it. Install it from https://nodejs.org, then run this installer again.'
        }

        # 2. Download agentarium (a zip, so git isn't needed)
        $url = "https://github.com/$repo/archive/$ref.zip"
        Write-Host "Downloading agentarium ($repo@$ref)..."
        $zip = Join-Path $tmp 'src.zip'
        try { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip }
        catch { Stop-WithMessage "download failed: $url (check your internet connection and try again)" }
        # Unpacked beside the app folder: Move-Item can't move a folder across drives.
        $stage = Join-Path $tkHome ('.download-' + [guid]::NewGuid())
        Expand-Archive -Path $zip -DestinationPath $stage -Force
        $src = Get-ChildItem $stage -Directory | Select-Object -First 1
        if (-not $src -or -not (Test-Path (Join-Path $src.FullName 'scripts\cli.ts'))) { Stop-WithMessage "the download doesn't look like agentarium." }
        # Replace only a folder this installer made, and by renaming: a folder with a file open in it
        # (VS Code's status bar item running a script, a virus scan) refuses the rename before anything
        # is deleted, so the old copy keeps working. Your recorded data beside it is never touched.
        if ((Test-Path $app) -and -not (Test-Path (Join-Path $app 'scripts\cli.ts'))) {
            Stop-WithMessage "$app exists but isn't an agentarium install; move it out of the way and run this again."
        }
        Get-ChildItem $tkHome -Directory -Filter 'app.old-*' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
        $old = Join-Path $tkHome ('app.old-' + [guid]::NewGuid())
        if (Test-Path $app) {
            try { Move-Item $app $old -ErrorAction Stop }
            catch { Stop-WithMessage "couldn't replace $app because something has a file in it open (VS Code, or the dashboard: agentarium dashboard --stop). Close it and run this again; nothing was changed." }
        }
        try { Move-Item $src.FullName $app -ErrorAction Stop }
        catch {
            if (Test-Path $old) { Move-Item $old $app -ErrorAction SilentlyContinue }
            Stop-WithMessage "couldn't put the new copy in place; the old one is kept."
        }
        Remove-Item $old -Recurse -Force -ErrorAction SilentlyContinue   # in use? the next run clears it
    } finally {
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
        if ($stage) { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue }
    }

    # 3. Put the `agentarium` command on PATH (for new terminals and this one)
    $bin = Join-Path $tkHome 'bin'
    New-Item -ItemType Directory -Path $bin -Force | Out-Null
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (($userPath -split ';') -contains $bin)) {
        [Environment]::SetEnvironmentVariable('Path', ((@($userPath, $bin) | Where-Object { $_ }) -join ';'), 'User')
    }
    if (-not (($env:Path -split ';') -contains $bin)) { $env:Path = "$env:Path;$bin" }

    # 4. Set everything up (plugin, status line, `agentarium` command)
    Write-Host ''
    $setupArgs = if ($env:AGENTARIUM_SETUP_ARGS) { $env:AGENTARIUM_SETUP_ARGS -split ' ' } else { @() }
    & $node --disable-warning=ExperimentalWarning (Join-Path $app 'scripts\cli.ts') setup @setupArgs
    if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'setup did not finish; see the messages above.' }
} catch {
    # Show a plain message, not a PowerShell stack trace, and leave the window open (iex runs in
    # the user's own session, so `exit` would close their terminal).
    if ("$_" -ne 'agentarium-stop') {
        Write-Host ''
        Write-Host "agentarium: something went wrong: $_" -ForegroundColor Red
        Write-Host 'Please try again; if it keeps failing, open an issue at https://github.com/andrew44/agentarium/issues' -ForegroundColor Red
    }
    $global:LASTEXITCODE = 1
} }
