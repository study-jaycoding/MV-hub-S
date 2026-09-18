param(
    [string]$RepositoryRoot = (Join-Path $PSScriptRoot "..")
)

$ErrorActionPreference = "Stop"

function Add-LintFailure {
    param([string]$Message)

    $script:LintFailures += $Message
    Write-Host "[ERROR] $Message"
}

function Get-StatusItemCount {
    param(
        [string]$Text,
        [string]$RelativePath
    )

    $lines = $Text -split "`r`n|`n|`r"
    $headingIndexes = @()
    $insideFence = $false

    for ($index = 0; $index -lt $lines.Count; $index++) {
        $line = $lines[$index]
        if ($insideFence) {
            if ($line -match '^\s{0,3}(?:`{3,}|~{3,})\s*$') {
                $insideFence = $false
            }
            continue
        }
        if ($line -match '^\s{0,3}(?:`{3,}|~{3,})') {
            $insideFence = $true
            continue
        }
        if ($line -match '^\s{0,3}##(?!#)[ \t]+지금 상태[ \t]*(?:#+[ \t]*)?$') {
            $headingIndexes += $index
        }
    }

    if ($headingIndexes.Count -ne 1) {
        Add-LintFailure "${RelativePath}: '## 지금 상태' H2 헤딩을 정확히 하나 찾지 못했습니다 (발견: $($headingIndexes.Count))."
        return $null
    }

    $count = 0
    $insideFence = $false
    for ($index = $headingIndexes[0] + 1; $index -lt $lines.Count; $index++) {
        $line = $lines[$index]
        if ($insideFence) {
            if ($line -match '^\s{0,3}(?:`{3,}|~{3,})\s*$') {
                $insideFence = $false
            }
            continue
        }
        if ($line -match '^\s{0,3}(?:`{3,}|~{3,})') {
            $insideFence = $true
            continue
        }
        if ($line -match '^\s{0,3}##(?!#)[ \t]+') {
            break
        }

        # 최상위 항목은 목록 표식이 열 0에 있어야 한다. 따라서 인용문과 들여쓴 중첩 목록은 세지 않는다.
        if ($line -match '^(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)') {
            $count++
        }
    }

    return $count
}

function Get-TableCells {
    param([string]$Line)

    if ($Line -notmatch '^\s*\|(?<cells>.*)\|\s*$') {
        return $null
    }
    return @($Matches.cells -split '\|' | ForEach-Object { $_.Trim() })
}

function Get-CanonicalText {
    param([string]$Text)

    return ($Text -replace '\*\*|__|`', '').Trim()
}

function Get-DocBudget {
    param([string]$Text)

    $lines = $Text -split "`r`n|`n|`r"
    $budgetHeadingIndexes = @()
    $insideFence = $false
    for ($index = 0; $index -lt $lines.Count; $index++) {
        $line = $lines[$index]
        if ($insideFence) {
            if ($line -match '^\s{0,3}(?:`{3,}|~{3,})\s*$') {
                $insideFence = $false
            }
            continue
        }
        if ($line -match '^\s{0,3}(?:`{3,}|~{3,})') {
            $insideFence = $true
            continue
        }
        if ($line -match '^\s{0,3}###[ \t]+현황판에 무엇을 남기나[ \t]*(?:#+[ \t]*)?$') {
            $budgetHeadingIndexes += $index
        }
    }
    if ($budgetHeadingIndexes.Count -ne 1) {
        Add-LintFailure "docs\README.md: '### 현황판에 무엇을 남기나' 섹션을 정확히 하나 찾지 못했습니다 (발견: $($budgetHeadingIndexes.Count))."
        return $null
    }

    $insideBudgetSection = $false
    $insideFence = $false
    $rows = @{}

    foreach ($line in $lines) {
        if ($insideFence) {
            if ($line -match '^\s{0,3}(?:`{3,}|~{3,})\s*$') {
                $insideFence = $false
            }
            continue
        }
        if ($line -match '^\s{0,3}(?:`{3,}|~{3,})') {
            $insideFence = $true
            continue
        }

        if (-not $insideBudgetSection) {
            if ($line -match '^\s{0,3}###[ \t]+현황판에 무엇을 남기나[ \t]*(?:#+[ \t]*)?$') {
                $insideBudgetSection = $true
            }
            continue
        }

        if ($line -match '^\s{0,3}(?:#|##|###)(?!#)[ \t]+') {
            break
        }

        $cells = Get-TableCells -Line $line
        if ($null -eq $cells -or $cells.Count -ne 2) {
            continue
        }
        $label = Get-CanonicalText -Text $cells[0]
        if ($label -notin @('운영 상한(초과 시 정리)', '정리 목표')) {
            continue
        }
        if ($rows.ContainsKey($label)) {
            Add-LintFailure "docs\README.md: 예산 표의 '$label' 행이 둘 이상입니다."
            return $null
        }
        $rows[$label] = Get-CanonicalText -Text $cells[1]
    }

    if (-not $insideBudgetSection) {
        Add-LintFailure "docs\README.md: '### 현황판에 무엇을 남기나' 섹션을 찾지 못했습니다."
        return $null
    }

    $parsedRows = @{}
    foreach ($label in @('운영 상한(초과 시 정리)', '정리 목표')) {
        if (-not $rows.ContainsKey($label)) {
            Add-LintFailure "docs\README.md: 예산 표의 '$label' 행을 찾지 못했습니다."
            return $null
        }

        $value = $rows[$label]
        $sizeMatch = [regex]::Match($value, '전체\s+(?<kib>\d+)\s*KiB', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        $itemsMatch = [regex]::Match($value, '현재\s*항목\s+(?<items>\d+)\s*개')
        if (-not $sizeMatch.Success -or -not $itemsMatch.Success) {
            Add-LintFailure "docs\README.md: '$label' 값 '$value'에서 '전체 NKiB · 현재 항목 N개'를 해석하지 못했습니다."
            return $null
        }
        $parsedRows[$label] = [pscustomobject]@{
            Bytes = [int64]$sizeMatch.Groups['kib'].Value * 1024
            Items = [int]$itemsMatch.Groups['items'].Value
        }
    }

    return [pscustomobject]@{
        OperatingLimit = $parsedRows['운영 상한(초과 시 정리)']
        CleanupTarget = $parsedRows['정리 목표']
    }
}

function Test-DocsForNulBytes {
    param(
        [string]$DocsDirectory,
        [string]$ProjectRoot
    )

    Get-ChildItem -LiteralPath $DocsDirectory -Recurse -File -Filter '*.md' |
        Sort-Object FullName |
        ForEach-Object {
            $file = $_
            try {
                $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
            }
            catch {
                Add-LintFailure "'$($file.FullName)'을 바이트로 읽지 못했습니다: $($_.Exception.Message)"
                return
            }

            $relativePath = $file.FullName.Substring($ProjectRoot.Length).TrimStart('\', '/') -replace '/', '\'
            for ($offset = 0; $offset -lt $bytes.Length; $offset++) {
                if ($bytes[$offset] -eq 0) {
                    Add-LintFailure "${relativePath}: NUL 바이트(0x00)가 바이트 오프셋 $offset(0-base)에 있습니다."
                }
            }
        }
}

$script:LintFailures = @()

try {
    $RepositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot -ErrorAction Stop).Path
    $docsDirectory = Join-Path $RepositoryRoot 'docs'
    $statusPath = Join-Path $docsDirectory 'CURRENT_STATUS.md'
    $readmePath = Join-Path $docsDirectory 'README.md'

    foreach ($requiredPath in @($docsDirectory, $statusPath, $readmePath)) {
        if (-not (Test-Path -LiteralPath $requiredPath)) {
            Add-LintFailure "필수 경로를 찾지 못했습니다: $requiredPath"
        }
    }

    if ($script:LintFailures.Count -eq 0) {
        $statusBytes = [System.IO.File]::ReadAllBytes($statusPath)
        $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
        try {
            $statusText = $utf8.GetString($statusBytes)
            $readmeText = $utf8.GetString([System.IO.File]::ReadAllBytes($readmePath))
        }
        catch {
            Add-LintFailure "문서 정본 또는 현황판을 UTF-8로 해석하지 못했습니다: $($_.Exception.Message)"
        }

        if ($script:LintFailures.Count -eq 0) {
            $budget = Get-DocBudget -Text $readmeText
            $itemCount = Get-StatusItemCount -Text $statusText -RelativePath 'docs\CURRENT_STATUS.md'
            if ($null -ne $budget -and $null -ne $itemCount) {
                $byteCount = [int64]$statusBytes.Length
                $kib = $byteCount / 1024.0
                Write-Host ("[OK] docs\CURRENT_STATUS.md: {0:N0} bytes ({1:N1} KiB), {2} items." -f $byteCount, $kib, $itemCount)

                if ($byteCount -gt $budget.OperatingLimit.Bytes) {
                    Write-Host ("[WARNING] docs\CURRENT_STATUS.md: 운영 상한 {0:N0} bytes를 {1:N0} bytes 초과했습니다." -f $budget.OperatingLimit.Bytes, ($byteCount - $budget.OperatingLimit.Bytes))
                }
                if ($itemCount -gt $budget.OperatingLimit.Items) {
                    Write-Host ("[WARNING] docs\CURRENT_STATUS.md: 운영 상한 {0}개를 {1}개 초과했습니다." -f $budget.OperatingLimit.Items, ($itemCount - $budget.OperatingLimit.Items))
                }
            }
        }
    }

    if (Test-Path -LiteralPath $docsDirectory) {
        Test-DocsForNulBytes -DocsDirectory $docsDirectory -ProjectRoot $RepositoryRoot
    }
}
catch {
    Add-LintFailure "검사 중 처리하지 못한 오류: $($_.Exception.Message)"
}

if ($script:LintFailures.Count -gt 0) {
    Write-Host "lint:docs failed with $($script:LintFailures.Count) error(s)."
    exit 1
}

Write-Host 'lint:docs completed (budget limit overruns are warnings during adoption).'
exit 0
