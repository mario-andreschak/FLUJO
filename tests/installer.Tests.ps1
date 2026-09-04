BeforeAll {
    . (Join-Path $PSScriptRoot '..\scripts\installer-functions.ps1')

    $script:CorePrerequisites = @(
        [PSCustomObject]@{ Command = 'git';  WingetId = 'Git.Git';       DisplayName = 'Git' }
        [PSCustomObject]@{ Command = 'node'; WingetId = 'OpenJS.NodeJS'; DisplayName = 'Node.js' }
    )
}

Describe 'Windows installer prerequisite planning' {
    It 'includes the ripgrep search accelerator in the managed prerequisite catalog' {
        $ripgrep = Get-KnownInstallerPrerequisites | Where-Object Command -eq 'rg'
        $ripgrep | Should -Not -BeNullOrEmpty
        $ripgrep.WingetId | Should -Be 'BurntSushi.ripgrep.MSVC'
        $ripgrep.DisplayName | Should -Be 'ripgrep'
    }

    It 'marks installed prerequisites as preexisting and does not reinstall them' {
        $available = @('winget', 'git', 'node')
        $plan = Get-PrerequisitePlan -Prerequisites $script:CorePrerequisites -CommandResolver {
            param($Name)
            if ($available -contains $Name) { [PSCustomObject]@{ Name = $Name } }
        }

        $plan.CanInstall | Should -BeTrue
        $plan.Prerequisites | Should -HaveCount 2
        $plan.Prerequisites[0].Preexisting | Should -BeTrue
        $plan.Prerequisites[0].Action | Should -Be 'Keep'
        $plan.Prerequisites[1].Action | Should -Be 'Keep'
    }

    It 'blocks missing prerequisites when winget is unavailable' {
        $plan = Get-PrerequisitePlan -Prerequisites $script:CorePrerequisites -CommandResolver {
            param($Name)
            if ($Name -eq 'git') { [PSCustomObject]@{ Name = $Name } }
        }

        $plan.WingetAvailable | Should -BeFalse
        $plan.CanInstall | Should -BeFalse
        ($plan.Prerequisites | Where-Object Command -eq 'git').Action | Should -Be 'Keep'
        ($plan.Prerequisites | Where-Object Command -eq 'node').Action | Should -Be 'Blocked'
    }

    It 'plans the correct winget package for a missing prerequisite' {
        $plan = Get-PrerequisitePlan -Prerequisites $script:CorePrerequisites -CommandResolver {
            param($Name)
            if ($Name -in @('winget', 'git')) { [PSCustomObject]@{ Name = $Name } }
        }

        $node = $plan.Prerequisites | Where-Object Command -eq 'node'
        $node.Action | Should -Be 'Install'
        $node.WingetId | Should -Be 'OpenJS.NodeJS'
        $node.Preexisting | Should -BeFalse
    }
}

Describe 'Windows installer target selection' {
    It 'uses LOCALAPPDATA for the default install directory' {
        $result = Get-DefaultInstallDirectory -LocalAppData 'C:\Users\tester\AppData\Local' -HomeDirectory 'C:\Users\tester'
        $result | Should -Be 'C:\Users\tester\AppData\Local\FLUJO'
    }

    It 'expands environment variables in a custom path' {
        $result = Resolve-InstallDirectory -RequestedPath '%TEMP%\Flujo Custom' -DefaultPath 'C:\fallback'
        $result | Should -Be (Join-Path $env:TEMP 'Flujo Custom')
    }

    It 'classifies an absent target as a clean install' {
        $intent = Get-InstallIntent -InstallDirectory 'C:\Apps\FLUJO' -PathExists $false -GitDirectoryExists $false
        $intent.Action | Should -Be 'Install'
        $intent.CanProceed | Should -BeTrue
    }

    It 'allows an existing empty target as a clean install' {
        $intent = Get-InstallIntent -InstallDirectory 'C:\Apps\FLUJO' -PathExists $true `
            -GitDirectoryExists $false -DirectoryIsEmpty $true
        $intent.Action | Should -Be 'Install'
        $intent.CanProceed | Should -BeTrue
    }

    It 'classifies an existing Git target as a rerun update' {
        $intent = Get-InstallIntent -InstallDirectory 'C:\Apps\FLUJO' -PathExists $true -GitDirectoryExists $true
        $intent.Action | Should -Be 'Update'
        $intent.CanProceed | Should -BeTrue
    }

    It 'rejects an existing non-Git target' {
        $intent = Get-InstallIntent -InstallDirectory 'C:\Apps\FLUJO' -PathExists $true `
            -GitDirectoryExists $false -DirectoryIsEmpty $false
        $intent.Action | Should -Be 'Reject'
        $intent.CanProceed | Should -BeFalse
    }
}

Describe 'Windows installer generated payloads' {
    It 'builds the complete uninstall manifest in memory' {
        $prerequisite = New-PrerequisiteRecord -CommandName 'git' -WingetId 'Git.Git' -DisplayName 'Git' -Preexisting $false
        $claude = [PSCustomObject]@{ Installed = $true; Preexisting = $false; NpmPackage = '@anthropic-ai/claude-code' }

        $manifest = ConvertTo-InstallManifest -AppDir 'C:\Apps\FLUJO' -BinDir 'C:\Users\tester\FLUJO-cli' `
            -Branch 'main' -RepoUrl 'https://github.com/mario-andreschak/FLUJO/' `
            -Prerequisites @($prerequisite) -DesktopShortcut $true `
            -ExecutionPolicyChanged $true -ClaudeCli $claude

        $manifest.schema | Should -Be 1
        $manifest.installDir | Should -Be 'C:\Apps\FLUJO'
        $manifest.binDir | Should -Be 'C:\Users\tester\FLUJO-cli'
        $manifest.branch | Should -Be 'main'
        $manifest.repoUrl | Should -Be 'https://github.com/mario-andreschak/FLUJO/'
        $manifest.desktopShortcut | Should -BeTrue
        $manifest.executionPolicyChanged | Should -BeTrue
        $manifest.claudeCli.installed | Should -BeTrue
        $manifest.claudeCli.npmPackage | Should -Be '@anthropic-ai/claude-code'
        $manifest.prerequisites | Should -HaveCount 1
        $manifest.prerequisites[0].preexisting | Should -BeFalse
    }

    It 'generates a launcher for the selected app directory without writing it' {
        $launcher = Get-LauncherContent -AppDir 'D:\Tools\FLUJO'

        $launcher | Should -Match 'set "FLUJO_HOME=D:\\Tools\\FLUJO"'
        $launcher | Should -Match 'package\.json'
        $launcher | Should -Match 'npm start %\*'
        $launcher | Should -Match 'http://localhost:4200'
    }
}

Describe 'Windows installer entry-point contracts' {
    BeforeAll {
        $script:InstallScriptPath = Join-Path $PSScriptRoot '..\scripts\install.ps1'
        $script:UninstallScriptPath = Join-Path $PSScriptRoot '..\scripts\uninstall.ps1'
        $script:HelperScriptPath = Join-Path $PSScriptRoot '..\scripts\installer-functions.ps1'
        $script:InnoScriptPath = Join-Path $PSScriptRoot '..\installer\flujo-setup.iss'
        $script:WorkflowPath = Join-Path $PSScriptRoot '..\.github\workflows\installer.yml'
    }

    It 'parses every PowerShell installer file with Windows PowerShell syntax' {
        foreach ($path in @($script:InstallScriptPath, $script:UninstallScriptPath, $script:HelperScriptPath, $PSCommandPath)) {
            $tokens = $null
            $errors = $null
            [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors) | Out-Null
            $errors | Should -HaveCount 0
        }
    }

    It 'keeps the one-line installer routed through the branch-matched helper' {
        $source = Get-Content -LiteralPath $script:InstallScriptPath -Raw
        $source | Should -Match 'raw\.githubusercontent\.com/mario-andreschak/FLUJO/\$Branch/scripts/installer-functions\.ps1'
    }

    It 'stops when a winget prerequisite installation fails' {
        $source = Get-Content -LiteralPath $script:InstallScriptPath -Raw
        $source | Should -Match 'winget install[\s\S]+\$LASTEXITCODE -ne 0[\s\S]+throw'
    }

    It 'requires every Inno wizard choice to reach the PowerShell environment' {
        $source = Get-Content -LiteralPath $script:InnoScriptPath -Raw
        $source | Should -Match 'procedure SetRequiredEnvironmentVariable'
        foreach ($name in @('FLUJO_DIR', 'FLUJO_BRANCH', 'FLUJO_SHORTCUT', 'FLUJO_OLLAMA', 'FLUJO_START', 'FLUJO_SET_POLICY')) {
            $source | Should -Match "SetRequiredEnvironmentVariable\('$name'"
        }
    }

    It 'gates tag publishing on Pester and package version consistency' {
        $source = Get-Content -LiteralPath $script:WorkflowPath -Raw
        $source | Should -Match 'installer-build:[\s\S]+needs: powershell-tests'
        $source | Should -Match '\$expectedTag = "v\$packageVersion"'
        $source | Should -Match "if: startsWith\(github\.ref, 'refs/tags/v'\)"
    }
}

Describe 'Windows uninstaller prerequisite decisions' {
    It 'defaults to removing FLUJO-installed prerequisites and keeping preexisting ones' {
        $manifest = [PSCustomObject]@{
            prerequisites = @(
                [PSCustomObject]@{ command = 'git'; wingetId = 'Git.Git'; displayName = 'Git'; preexisting = $true }
                [PSCustomObject]@{ command = 'node'; wingetId = 'OpenJS.NodeJS'; displayName = 'Node.js'; preexisting = $false }
                [PSCustomObject]@{ command = 'ollama'; wingetId = 'Ollama.Ollama'; displayName = 'Ollama'; preexisting = $false }
            )
        }
        $decisions = Get-UninstallPrerequisiteDecisions -Manifest $manifest -CommandResolver {
            param($Name)
            [PSCustomObject]@{ Name = $Name }
        }

        ($decisions | Where-Object Command -eq 'git').Remove | Should -BeFalse
        ($decisions | Where-Object Command -eq 'node').Remove | Should -BeTrue
        ($decisions | Where-Object Command -eq 'ollama').Remove | Should -BeTrue
    }

    It 'allows optional prerequisite removal answers to override defaults' {
        $manifest = [PSCustomObject]@{
            prerequisites = @(
                [PSCustomObject]@{ command = 'node'; wingetId = 'OpenJS.NodeJS'; displayName = 'Node.js'; preexisting = $false }
            )
        }
        $decisions = Get-UninstallPrerequisiteDecisions -Manifest $manifest `
            -CommandResolver { param($Name) [PSCustomObject]@{ Name = $Name } } `
            -AnswerResolver { param($Candidate) $false }

        $decisions[0].DefaultRemove | Should -BeTrue
        $decisions[0].Remove | Should -BeFalse
    }

    It 'keeps detected prerequisites by default when no manifest exists' {
        $known = @([PSCustomObject]@{ command = 'git'; wingetId = 'Git.Git'; displayName = 'Git' })
        $decisions = Get-UninstallPrerequisiteDecisions -Manifest $null -KnownPrerequisites $known `
            -CommandResolver { param($Name) [PSCustomObject]@{ Name = $Name } }

        $decisions[0].HasManifest | Should -BeFalse
        $decisions[0].DefaultRemove | Should -BeFalse
        $decisions[0].Remove | Should -BeFalse
    }

    It 'does not ask to remove commands that are absent' {
        $script:answerCalls = 0
        $manifest = [PSCustomObject]@{
            prerequisites = @(
                [PSCustomObject]@{ command = 'uv'; wingetId = 'astral-sh.uv'; displayName = 'uv'; preexisting = $false }
            )
        }
        $decisions = Get-UninstallPrerequisiteDecisions -Manifest $manifest `
            -CommandResolver { param($Name) $null } `
            -AnswerResolver { param($Candidate) $script:answerCalls += 1; $true }

        $script:answerCalls | Should -Be 0
        $decisions[0].Present | Should -BeFalse
        $decisions[0].Remove | Should -BeFalse
    }
}

Describe 'Windows installer Node.js version validation' {
    BeforeAll {
        # Mock command resolver that returns a fake command object
        $script:mockCommand = [PSCustomObject]@{ Source = 'C:\\Program Files\\nodejs\\node.exe' }
    }

    It 'returns Supported for v22.0.0' {
        $result = Test-NodeVersion -CommandResolver { param($Name) $script:mockCommand } -VersionResolver { param($Cmd) 'v22.0.0' } -MinMajor 22 -MinMinor 0
        $result.Status | Should -Be 'Supported'
        $result.Version | Should -Be '22.0.0'
    }

    It 'returns Supported for 22.0.0 (no leading v)' {
        $result = Test-NodeVersion -CommandResolver { param($Name) $script:mockCommand } -VersionResolver { param($Cmd) '22.0.0' } -MinMajor 22 -MinMinor 0
        $result.Status | Should -Be 'Supported'
        $result.Version | Should -Be '22.0.0'
    }

    It 'returns Supported for later 22.x releases' {
        $result = Test-NodeVersion -CommandResolver { param($Name) $script:mockCommand } -VersionResolver { param($Cmd) '22.14.0' } -MinMajor 22 -MinMinor 0
        $result.Status | Should -Be 'Supported'
        $result.Version | Should -Be '22.14.0'
    }

    It 'returns Supported for higher major versions' {
        $result = Test-NodeVersion -CommandResolver { param($Name) $script:mockCommand } -VersionResolver { param($Cmd) '23.0.0' } -MinMajor 22 -MinMinor 0
        $result.Status | Should -Be 'Supported'
        $result.Version | Should -Be '23.0.0'
    }

    It 'returns Outdated for Node 18.x' {
        $result = Test-NodeVersion -CommandResolver { param($Name) $script:mockCommand } -VersionResolver { param($Cmd) '18.20.0' } -MinMajor 22 -MinMinor 0
        $result.Status | Should -Be 'Outdated'
        $result.Version | Should -Be '18.20.0'
    }

    It 'returns Outdated for Node 20.x' {
        $result = Test-NodeVersion -CommandResolver { param($Name) $script:mockCommand } -VersionResolver { param($Cmd) '20.18.0' } -MinMajor 22 -MinMinor 0
        $result.Status | Should -Be 'Outdated'
        $result.Version | Should -Be '20.18.0'
    }

    It 'returns Missing when command not found' {
        $result = Test-NodeVersion -CommandResolver { param($Name) $null } -MinMajor 22 -MinMinor 0
        $result.Status | Should -Be 'Missing'
        $result.Version | Should -BeNullOrEmpty
    }

    It 'returns Malformed for empty stdout' {
        $result = Test-NodeVersion -CommandResolver { param($Name) $script:mockCommand } -VersionResolver { param($Cmd) '' } -MinMajor 22 -MinMinor 0
        $result.Status | Should -Be 'Malformed'
    }

    It 'returns Malformed for partial version' {
        $result = Test-NodeVersion -CommandResolver { param($Name) $script:mockCommand } -VersionResolver { param($Cmd) '22' } -MinMajor 22 -MinMinor 0
        $result.Status | Should -Be 'Malformed'
    }

    It 'returns Malformed for non-numeric components' {
        $result = Test-NodeVersion -CommandResolver { param($Name) $script:mockCommand } -VersionResolver { param($Cmd) '22.0.x' } -MinMajor 22 -MinMinor 0
        $result.Status | Should -Be 'Malformed'
    }

    It 'returns Malformed for output with extra text' {
        $result = Test-NodeVersion -CommandResolver { param($Name) $script:mockCommand } -VersionResolver { param($Cmd) 'Node.js v22.0.0' } -MinMajor 22 -MinMinor 0
        $result.Status | Should -Be 'Malformed'
    }

    It 'returns ProbeFailed for non-zero exit with empty output' {
        $result = Test-NodeVersion -CommandResolver { param($Name) $script:mockCommand } -VersionResolver { param($Cmd) [PSCustomObject]@{ Output = ''; ExitCode = 1 } } -MinMajor 22 -MinMinor 0
        $result.Status | Should -Be 'ProbeFailed'
    }

    It 'returns ProbeFailed for non-zero exit with apparently valid output' {
        $result = Test-NodeVersion -CommandResolver { param($Name) $script:mockCommand } -VersionResolver { param($Cmd) [PSCustomObject]@{ Output = '22.0.0'; ExitCode = 1 } } -MinMajor 22 -MinMinor 0
        $result.Status | Should -Be 'ProbeFailed'
    }

    It 'never classifies unsupported Node as Keep' {
        $result = Test-NodeVersion -CommandResolver { param($Name) $script:mockCommand } -VersionResolver { param($Cmd) '18.20.0' } -MinMajor 22 -MinMinor 0
        $result.Status | Should -Not -Be 'Keep'
    }
}


Describe 'Corporate-network installer helpers' {
    It 'accepts only absolute HTTP(S) proxy URIs' {
        Test-InstallerProxyUri 'https://proxy.example.test:8443' | Should -BeTrue
        Test-InstallerProxyUri 'http://user:password@proxy.example.test' | Should -BeTrue
        Test-InstallerProxyUri '' | Should -BeTrue
        Test-InstallerProxyUri 'proxy.example.test:8443' | Should -BeFalse
        Test-InstallerProxyUri 'socks5://proxy.example.test' | Should -BeFalse
    }

    It 'maps FLUJO aliases into a process-only child environment' {
        $inputEnvironment = @{
            FLUJO_HTTP_PROXY = 'http://proxy.example.test:8080'
            FLUJO_HTTPS_PROXY = 'https://proxy.example.test:8443'
            FLUJO_NO_PROXY = 'localhost,.example.test'
            FLUJO_PLAYWRIGHT_DOWNLOAD_HOST = 'https://browser-mirror.example.test'
            FLUJO_PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT = '45000'
            NODE_OPTIONS = '--trace-warnings'
            NODE_TLS_REJECT_UNAUTHORIZED = '0'
        }
        $before = $inputEnvironment | ConvertTo-Json -Compress

        $mapped = Get-FlujoInstallerEnvironment -ProcessEnvironment $inputEnvironment -SupportsSystemCa $true

        $mapped.HTTP_PROXY | Should -Be 'http://proxy.example.test:8080'
        $mapped.HTTPS_PROXY | Should -Be 'https://proxy.example.test:8443'
        $mapped.NO_PROXY | Should -Be 'localhost,.example.test'
        $mapped.PLAYWRIGHT_DOWNLOAD_HOST | Should -Be 'https://browser-mirror.example.test'
        $mapped.PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT | Should -Be '45000'
        $mapped.NODE_OPTIONS | Should -Match '--trace-warnings'
        $mapped.NODE_OPTIONS | Should -Match '--use-system-ca'
        $mapped.ContainsKey('NODE_TLS_REJECT_UNAUTHORIZED') | Should -BeFalse
        ($inputEnvironment | ConvertTo-Json -Compress) | Should -Be $before
    }

    It 'preserves explicitly supplied standard proxy settings when aliases are absent' {
        $mapped = Get-FlujoInstallerEnvironment -ProcessEnvironment @{
            HTTP_PROXY = 'http://standard-proxy.example.test:8080'
            HTTPS_PROXY = 'https://standard-proxy.example.test:8443'
        }

        $mapped.HTTP_PROXY | Should -Be 'http://standard-proxy.example.test:8080'
        $mapped.HTTPS_PROXY | Should -Be 'https://standard-proxy.example.test:8443'
    }

    It 'rejects missing and non-PEM custom CA files' {
        Test-InstallerPemCertificateFile (Join-Path $TestDrive 'missing.pem') | Should -BeFalse
        $invalidPath = Join-Path $TestDrive 'invalid.pem'
        Set-Content -LiteralPath $invalidPath -Value 'not a certificate'
        Test-InstallerPemCertificateFile $invalidPath | Should -BeFalse
    }

    It 'accepts a readable PEM envelope with decodable certificate bytes' {
        $pemPath = Join-Path $TestDrive 'corporate-ca.pem'
        Set-Content -LiteralPath $pemPath -Value @'
-----BEGIN CERTIFICATE-----
AQID
-----END CERTIFICATE-----
'@
        Test-InstallerPemCertificateFile $pemPath -CertificateValidator { param($Bytes) $Bytes.Length -gt 0 } | Should -BeTrue
        $mapped = Get-FlujoInstallerEnvironment -ProcessEnvironment @{
            FLUJO_EXTRA_CA_CERTS = $pemPath
        } -CertificateValidator { param($Bytes) $Bytes.Length -gt 0 }
        $mapped.NODE_EXTRA_CA_CERTS | Should -Be $pemPath
        $mapped.npm_config_cafile | Should -Be $pemPath
    }

    It 'redacts proxy credentials, authorization, npm tokens, query secrets, and CA paths' {
        $caPath = 'C:\private\sentinel-corporate-ca.pem'
        $diagnostic = @(
            'https://sentinel-user:sentinel-password@proxy.example.test:8443'
            'Authorization: Bearer sentinel-bearer'
            '//registry.example.test/:_authToken=sentinel-npm-token'
            'https://download.example.test/file?token=sentinel-query'
            'API_SECRET=sentinel-env-secret'
            $caPath
        ) -join "`n"

        $safe = Protect-InstallerDiagnostic -Text $diagnostic -SensitiveValues @($caPath)

        foreach ($secret in @(
            'sentinel-user',
            'sentinel-password',
            'sentinel-bearer',
            'sentinel-npm-token',
            'sentinel-query',
            'sentinel-env-secret',
            $caPath
        )) {
            $safe | Should -Not -Match ([regex]::Escape($secret))
        }
        $safe | Should -Match '\[REDACTED\]'
    }
}

Describe 'Corporate-network installer source contracts' {
    BeforeAll {
        $script:InstallSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\scripts\install.ps1') -Raw
        $script:UnixInstallSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\scripts\install.sh') -Raw
        $script:InnoSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\installer\flujo-setup.iss') -Raw
        $script:BrowserPackage = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\mcp-servers\browser\package.json') -Raw | ConvertFrom-Json
    }

    It 'keeps dependency lifecycles enabled and provisions managed Chromium explicitly' {
        $script:InstallSource | Should -Match "FLUJO_SKIP_PATCHRIGHT_DOWNLOAD"
        $script:InstallSource | Should -Match "patchright-chromium"
        $script:UnixInstallSource | Should -Match "patchright-chromium"
        $script:InstallSource | Should -Not -Match "npm ci --ignore-scripts"
        $script:UnixInstallSource | Should -Not -Match "npm ci --ignore-scripts"
        $script:BrowserPackage.scripts.install | Should -Be 'node scripts/install-browser.mjs'
        $script:BrowserPackage.dependencies.patchright | Should -Be '1.61.1'
    }

    It 'propagates corporate-network inputs and diagnostic paths through Inno Setup' {
        foreach ($name in @(
            'FLUJO_HTTP_PROXY',
            'FLUJO_HTTPS_PROXY',
            'FLUJO_NO_PROXY',
            'FLUJO_EXTRA_CA_CERTS',
            'FLUJO_PLAYWRIGHT_DOWNLOAD_HOST',
            'FLUJO_PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT',
            'FLUJO_INSTALL_LOG',
            'FLUJO_INSTALL_STAGE_FILE'
        )) {
            $script:InnoSource | Should -Match ([regex]::Escape($name))
        }
        $script:InnoSource | Should -Match 'LoadStringFromFile'
        $script:InnoSource | Should -Match 'sanitized diagnostic log'
    }

    It 'warns about inherited TLS bypasses without forwarding them to installer commands' {
        $script:InstallSource | Should -Match 'Security warning: NODE_TLS_REJECT_UNAUTHORIZED'
        $script:UnixInstallSource | Should -Match 'unset NODE_TLS_REJECT_UNAUTHORIZED'
        $script:InstallSource | Should -Match "Remove-Item -LiteralPath 'Env:\\NODE_TLS_REJECT_UNAUTHORIZED'"
    }
}
