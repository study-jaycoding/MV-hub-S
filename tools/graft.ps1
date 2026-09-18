<#
  Wrapper for the graft CLI. Always call graft through this script.

  Why it exists
  -------------
  1. ELECTRON_RUN_AS_NODE
     Agent sessions run inside VS Code, which sets ELECTRON_RUN_AS_NODE=1.
     node-gyp-build then reports runtime=electron and graft dies with
     "No native build was found for ... runtime=electron abi=137", even though
     the node prebuilds are present. Removing the variable for this process
     only makes it resolve runtime=node. Do not clear it globally - the editor
     itself uses it.

  2. graft build rewrites repository control files
     Plain "graft build" appends /graft/ to .gitignore and creates a root
     .ignore that re-admits graft/ to ripgrep. That .ignore makes every symbol
     search return the generated card next to the real source. We keep the
     .gitignore entry under our own control and suppress both writes.

  Install notes (verified on this PC, 2026-09-18)
  -----------------------------------------------
  - npm i -g @nanonets/graft
  - npm's bundled node-gyp 11.x cannot read Visual Studio Build Tools 2026
    (18.4). Without a newer one the tree-sitter-kotlin build fails with
    "find VS unknown version". Fix: npm i -g node-gyp@13, then set
    npm_config_node_gyp to its bin/node-gyp.js for the install only.
  - Telemetry defaults to on and posts to events.nanonets.com.
    It is disabled on this machine via "graft telemetry disable".

  Never run "graft init" in this repository: it overwrites AGENTS.md, which
  must stay identical to CLAUDE.md.
#>
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$GraftArgs = @()
)

$ErrorActionPreference = "Stop"

if ($GraftArgs.Count -eq 0) { $GraftArgs = @("--help") }

if ($GraftArgs[0] -eq "init") {
    # Write-Error would trip $ErrorActionPreference = "Stop" and exit 1 before
    # the intended code below, so report on the error stream directly.
    [Console]::Error.WriteLine("graft init is blocked here: it overwrites AGENTS.md. Use 'build' instead.")
    exit 2
}

# Keep graft from editing .gitignore / creating .ignore on every build.
if ($GraftArgs[0] -eq "build") {
    foreach ($flag in @("--no-gitignore", "--no-ignore")) {
        if ($GraftArgs -notcontains $flag) { $GraftArgs += $flag }
    }
}

$Graft = (Get-Command graft -ErrorAction SilentlyContinue)
if ($null -eq $Graft) {
    [Console]::Error.WriteLine("graft is not installed. See the install notes at the top of this file.")
    exit 127
}

$Saved = $env:ELECTRON_RUN_AS_NODE
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
try {
    & graft @GraftArgs
    $Code = $LASTEXITCODE
}
finally {
    if ($null -ne $Saved) { $env:ELECTRON_RUN_AS_NODE = $Saved }
}

exit $Code
