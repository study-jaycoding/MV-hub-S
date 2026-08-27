[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [int]$Preferred,
    # Test hook: comma-separated "start-end" ranges. Default: read the live netsh excluded port ranges.
    [string]$Ranges = ""
)

# Prints the first candidate port that is NOT inside a Windows excluded port range.
# Windows (Hyper-V / WSL / Docker) reserves blocks such as 5141-5240 for its own dynamic use;
# listen() on a port inside such a block fails with EACCES even though nothing is using it.
# Order: $Preferred first, then fixed fallbacks. Never fails: on any error it prints $Preferred.
$ErrorActionPreference = "Continue"
$candidates = @($Preferred, 3173, 3174, 3175, 4174, 4175, 8173)

try {
    # Ranges as two parallel int lists (nested arrays are easy to get wrong in PowerShell 5.1).
    $starts = New-Object System.Collections.Generic.List[int]
    $ends = New-Object System.Collections.Generic.List[int]
    if ($Ranges -ne "") {
        foreach ($item in $Ranges.Split(",")) {
            $parts = $item.Trim().Split("-")
            if ($parts.Length -eq 2) { $starts.Add([int]$parts[0]); $ends.Add([int]$parts[1]) }
        }
    }
    else {
        $lines = & netsh.exe interface ipv4 show excludedportrange protocol=tcp
        foreach ($line in $lines) {
            if ($line -match '^\s*(\d+)\s+(\d+)') { $starts.Add([int]$matches[1]); $ends.Add([int]$matches[2]) }
        }
    }
    foreach ($port in $candidates) {
        $blocked = $false
        for ($i = 0; $i -lt $starts.Count; $i++) {
            if ($port -ge $starts[$i] -and $port -le $ends[$i]) { $blocked = $true; break }
        }
        if (-not $blocked) {
            Write-Output $port
            exit 0
        }
    }
    Write-Output $Preferred
}
catch {
    Write-Output $Preferred
}
