# Security policy

## 지원 및 취약점 신고

일반적인 사용 문의와 재현 가능한 버그는 [GitHub Issues](https://github.com/SWBaek/lg-report-gen/issues)에 등록하십시오. 비공개로 보안 취약점을 신고하려면 저장소의 **Security → Advisories → Report a vulnerability**에서 GitHub private vulnerability report를 사용하십시오. 공개 이슈에 취약점 세부 내용을 게시하지 마십시오.

private vulnerability reporting이 저장소에서 활성화되어 있지 않다면 저장소 관리자에게 먼저 해당 기능을 활성화하도록 요청하십시오. 신고에는 영향 버전, 재현 단계, 영향 범위와 완화 방법을 포함하되 토큰·인증 파일·원본 보고서 내용은 첨부하지 마십시오.

## 지원 버전

보안 수정은 최신 GitHub Release를 기준으로 제공합니다. 지원되는 버전은 [Releases](https://github.com/SWBaek/lg-report-gen/releases)와 README의 다운로드 안내를 확인하십시오.

## 릴리스 보안

릴리스는 태그와 `package.json` 버전 일치, 후보 검사, Electron E2E, 패키지 실행 테스트, SHA-256 검증, CycloneDX/SPDX SBOM, production license bundle, provenance attestation을 통과해야 합니다. Windows 코드 서명은 `WINDOWS_CERTIFICATE_BASE64`와 `WINDOWS_CERTIFICATE_PASSWORD` 저장소 Secret 및 `RELEASE_SIGNING_REQUIRED=true` 저장소 Variable을 구성한 경우에만 필수화됩니다. 인증서가 구성되지 않은 개발 빌드는 unsigned로 남으며 서명을 위조하지 않습니다.

GitHub Advanced Security의 secret scanning과 push protection은 저장소/조직 관리자가 **Settings → Security → Advanced Security**에서 별도로 활성화해야 합니다. 이 저장소에는 인증 파일이나 비밀을 커밋하지 말고, 탐지된 비밀은 즉시 폐기·교체하십시오.
