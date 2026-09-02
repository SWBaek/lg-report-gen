import { useEffect, useState } from 'react';
import type { BootstrapState, ProviderSnapshot } from '../../../../shared/types';

const INSTALL =
  'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"';
export function SettingsView({
  state,
  onChanged,
}: {
  state: BootstrapState;
  onChanged: (state: BootstrapState) => void;
}) {
  const [provider, setProvider] = useState<ProviderSnapshot>(state.provider);
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    try {
      const next = await window.lgReportAgent.codex.refresh();
      setProvider(next);
      onChanged({ ...state, provider: next });
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => setProvider(state.provider), [state.provider]);
  return (
    <div className="settings">
      <h1>설정</h1>
      <section className="settings-section">
        <h2>일반</h2>
        <div className="setting-row">
          <div>현재 Workspace</div>
          <div className="setting-value">{state.workspacePath}</div>
          <button className="button" onClick={() => void window.lgReportAgent.workspace.open()}>
            폴더 열기
          </button>
          <button
            className="button"
            onClick={async () => {
              const path = await window.lgReportAgent.workspace.choose();
              if (path) onChanged(await window.lgReportAgent.bootstrap.get());
            }}
          >
            변경
          </button>
        </div>
        <div className="setting-row">
          <div>자동 저장</div>
          <div className="setting-value">편집 후 0.7초</div>
        </div>
        <div className="setting-row">
          <div>기본 보고서</div>
          <div className="setting-value">한국어 · A4 · 표준 문체</div>
        </div>
      </section>
      <section className="settings-section">
        <h2>Codex</h2>
        <div className="setting-row">
          <div>상태</div>
          <div className="setting-value">{stateLabel(provider.state)}</div>
          <button className="primary" disabled={busy} onClick={() => void refresh()}>
            {busy ? '확인 중…' : '새로고침'}
          </button>
        </div>
        <div className="setting-row">
          <div>실행 파일</div>
          <div className="setting-value">{provider.resolvedExecutablePath ?? '찾지 못함'}</div>
          <button
            className="button"
            onClick={async () => {
              const selected = await window.lgReportAgent.codex.browse();
              if (selected) {
                setProvider(selected);
                onChanged({ ...state, provider: selected });
              }
            }}
          >
            직접 선택
          </button>
        </div>
        <div className="setting-row">
          <div>Version / App Server</div>
          <div className="setting-value">
            {provider.version ?? '-'} / {provider.appServerSupported ? '지원' : '확인 불가'}
          </div>
        </div>
        <div className="setting-row">
          <div>인증</div>
          <div className="setting-value">
            {provider.authenticated
              ? `인증됨 ${provider.maskedAccount ?? ''}`
              : provider.authenticationState === 'unauthenticated'
                ? '로그인 필요'
                : '확인 불가'}{' '}
            {provider.planType ?? ''}
          </div>
          {!provider.authenticated && provider.installed && (
            <button className="button" onClick={() => void window.lgReportAgent.codex.login()}>
              Codex 로그인
            </button>
          )}
        </div>
        <div className="setting-row">
          <div>모델</div>
          <div className="setting-value">
            {provider.availableModels.find((model) => model.id === provider.selectedModel)
              ?.displayName ?? '동적 조회 전'}
          </div>
        </div>
        {provider.availableModels.length > 0 && (
          <div className="notice">
            보고서별 모델과 Reasoning Effort는 새 보고서의 고급 설정에서 선택합니다.
          </div>
        )}
        <div className="setting-row">
          <div>마지막 확인</div>
          <div className="setting-value">
            {provider.lastCheckedAt ? new Date(provider.lastCheckedAt).toLocaleString() : '-'}
          </div>
          <button
            className="button"
            onClick={() => void window.lgReportAgent.system.diagnosticCopy()}
          >
            진단 정보 복사
          </button>
        </div>
        {provider.state === 'missing' && <MissingNotice />}
        {provider.actionableMessage && provider.state !== 'missing' && (
          <div className="notice">{provider.actionableMessage}</div>
        )}
      </section>
      <section className="settings-section">
        <h2>Report</h2>
        <div className="setting-row">
          <div>A4 기본값</div>
          <div className="setting-value">사용 · 여백 20mm</div>
        </div>
        <div className="setting-row">
          <div>기본 Persona</div>
          <div className="setting-value">
            {state.personas.find((p) => p.isDefault)?.name ?? '팀장/관리자 보고용'}
          </div>
        </div>
      </section>
      <section className="settings-section">
        <h2>데이터</h2>
        <div className="setting-row">
          <div>로컬 데이터 위치</div>
          <div className="setting-value">{state.workspacePath}</div>
        </div>
        <div className="notice">
          Workspace 전환 시 기존 Workspace를 이동하거나 삭제하지 않습니다. 제거 프로그램도 Workspace
          데이터를 삭제하지 않습니다.
        </div>
      </section>
    </div>
  );
}
function MissingNotice() {
  return (
    <div className="error-box">
      <strong>Codex CLI가 설치되어 있지 않습니다.</strong>
      <p>
        이 애플리케이션은 사용자의 Codex CLI 인증을 사용합니다. Codex CLI를 설치하고 로그인한 뒤
        새로고침을 실행하십시오.
      </p>
      {[
        [INSTALL, '설치 명령'],
        ['codex login', '로그인 명령'],
        ['codex login status', '인증 상태 확인'],
      ].map(([command, label]) => (
        <div className="setting-row" key={label}>
          <code>{command}</code>
          <button
            className="button"
            onClick={() => void window.lgReportAgent.system.copy(command!)}
          >
            복사
          </button>
        </div>
      ))}
      <button
        className="button"
        onClick={() =>
          void window.lgReportAgent.system.openExternal('https://developers.openai.com/codex/cli')
        }
      >
        공식 안내 열기
      </button>
    </div>
  );
}
function stateLabel(value: ProviderSnapshot['state']): string {
  return {
    unknown: '확인 전',
    checking: '확인 중',
    missing: '미설치',
    incompatible: '업데이트 필요',
    unauthenticated: '로그인 필요',
    starting: '시작 중',
    ready: '준비됨',
    busy: '작업 중',
    reconnecting: '재연결 중',
    error: '오류',
    stopped: '중지됨',
  }[value];
}
