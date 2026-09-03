# Release operations

## 통제된 게시 흐름

`v<package.json version>` 태그를 push하면 Windows runner가 다음 순서를 수행합니다.

1. 태그·버전 일치 및 후보 검사를 확인한다.
2. Electron workflow와 packaged application E2E를 실행한다.
3. Electron-builder로 Portable/NSIS 패키지를 만들고 Electron fuse 상태를 검증한다. Playwright packaged E2E는 동일 `win-unpacked` 디렉터리의 unsigned 임시 clone에서만 inspector fuse를 켜며, 원본 EXE의 SHA-256·fuse wire·Authenticode 상태를 전후 비교하고 clone을 삭제한다.
4. 설정된 경우 Authenticode 서명을 검증한다.
5. CycloneDX와 SPDX SBOM, production dependency license bundle을 만든다.
6. SHA-256 목록을 생성·재검증하고 GitHub artifact provenance attestation을 만든다.
7. 아직 존재하지 않는 해당 태그의 GitHub Release에 EXE와 검증 메타데이터를 게시한다.

Release workflow는 이미 존재하는 Release를 덮어쓰지 않습니다. 태그를 재사용하거나 기존 asset을 교체하는 대신 문제 릴리스를 별도로 표시하고 수정 버전을 새 태그로 발행하십시오. GitHub 저장소 설정에서 tag protection/ruleset과 관리자만 Release를 만들 수 있는 권한을 함께 적용해야 합니다.

## 코드 서명

현재 저장소에는 실제 인증서가 포함되어 있지 않습니다. 서명 릴리스 전에 다음 저장소 설정을 관리자 권한으로 구성하십시오.

- Secret `WINDOWS_CERTIFICATE_BASE64`: 암호화된 `.p12`/`.pfx`의 base64 값
- Secret `WINDOWS_CERTIFICATE_PASSWORD`: 인증서 비밀번호
- Variable `RELEASE_SIGNING_REQUIRED=true`

electron-builder는 `CSC_LINK`와 `CSC_KEY_PASSWORD`를 사용합니다. Variable을 `false`로 두거나 로컬에서 생략하면 unsigned build를 만들 수 있지만, Release workflow 기본값은 signing required이며 인증서가 없으면 게시 전에 실패합니다. 서명되지 않은 파일에 서명되었다고 표시하지 마십시오.

## 다운로드 검증

Release asset과 함께 게시된 `SHA256SUMS.txt`를 다운로드한 뒤 Windows PowerShell에서 다음처럼 확인합니다.

```powershell
Get-FileHash .\LG-Report-Agent-Setup-<version>-x64.exe -Algorithm SHA256
Get-Content .\SHA256SUMS.txt
```

개발/운영 점검에서는 `npm run release:verify`로 모든 release EXE의 목록을 검증하고, signing-required Windows runner에서는 `npm run verify:release-signatures`로 Authenticode 체인을 검증합니다. SBOM은 `artifacts/sbom/`에, 라이선스 묶음은 `artifacts/licenses/`에 생성됩니다.

현재 renderer는 `file://`를 사용하므로 `grantFileProtocolExtraPrivileges`를 활성화한다. 장기적으로 custom `app://` protocol로 전환하면 이 fuse를 다시 비활성화하고 그 변경을 별도 검증한다.

## 롤백

배포 후 회귀가 확인되면 문제가 있는 Release asset을 교체하거나 태그를 이동하지 마십시오. 먼저 최신 정상 태그의 Release를 사용자에게 안내하고, 현재 태그는 GitHub Release에서 `yanked`임을 명시한 뒤 새 patch 버전을 발행합니다. 이미 설치된 앱은 OS의 앱 제거 절차를 따르고, Workspace 데이터는 삭제하지 않도록 백업 후 복원하십시오. 긴급 차단은 저장소 Release를 draft로 전환하고 배포 채널에서 링크를 제거하는 방식으로 수행하며, 모든 조치는 incident 기록에 남깁니다.
