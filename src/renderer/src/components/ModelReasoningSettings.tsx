import type { ModelInfo, ProviderSnapshot } from '../../../shared/types';
import { Bot, Brain } from 'lucide-react';

export interface ModelReasoningValue {
  model: string | null;
  reasoningEffort: string | null;
}

export function ModelReasoningSettings({
  provider,
  value,
  onChange,
  onRefresh,
  labelPrefix = '',
  compact = false,
}: {
  provider: ProviderSnapshot;
  value: ModelReasoningValue;
  onChange: (value: ModelReasoningValue) => void;
  onRefresh: () => Promise<void>;
  labelPrefix?: string;
  compact?: boolean;
}) {
  const selected = provider.availableModels.find((model) => model.id === value.model);
  const modelLabel = `${labelPrefix}모델`;
  const effortLabel = `${labelPrefix}Reasoning Effort`;

  return (
    <div className={`model-settings${compact ? ' compact' : ''}`}>
      <div className="field model-field">
        <label className={compact ? 'sr-only' : undefined}>{modelLabel}</label>
        {compact && <Bot size={18} aria-hidden="true" />}
        <select
          aria-label={modelLabel}
          value={selected?.id ?? ''}
          disabled={provider.availableModels.length === 0}
          onChange={(event) => {
            const model = provider.availableModels.find((item) => item.id === event.target.value);
            onChange({ model: model?.id ?? null, reasoningEffort: preferredEffort(model) });
          }}
        >
          {provider.availableModels.length === 0 && <option value="">모델 정보 없음</option>}
          {provider.availableModels.map((model) => (
            <option key={model.id} value={model.id}>
              {model.displayName}
              {model.isDefault ? ' · 기본' : ''}
            </option>
          ))}
        </select>
      </div>
      <div className="field model-field">
        <label className={compact ? 'sr-only' : undefined}>{effortLabel}</label>
        {compact && <Brain size={18} aria-hidden="true" />}
        <select
          aria-label={effortLabel}
          value={value.reasoningEffort ?? ''}
          disabled={!selected?.reasoningEfforts.length}
          onChange={(event) => onChange({ ...value, reasoningEffort: event.target.value || null })}
        >
          {!selected?.reasoningEfforts.length && <option value="">지원 정보 없음</option>}
          {selected?.reasoningEfforts.map((effort) => (
            <option key={effort} value={effort}>
              {reasoningLabel(effort)}
            </option>
          ))}
        </select>
      </div>
      {provider.availableModels.length === 0 && (
        <div className="model-unavailable">
          <span>Codex에서 모델 목록을 가져와야 선택할 수 있습니다.</span>
          <button className="button" type="button" onClick={() => void onRefresh()}>
            Codex 새로고침
          </button>
        </div>
      )}
    </div>
  );
}

export function initialModelReasoning(
  provider: ProviderSnapshot,
  current?: ModelReasoningValue,
): ModelReasoningValue {
  const currentModel = provider.availableModels.find((item) => item.id === current?.model);
  const model =
    currentModel ??
    provider.availableModels.find((item) => item.id === provider.selectedModel) ??
    provider.availableModels.find((item) => item.isDefault) ??
    provider.availableModels[0];
  const currentEffort = current?.reasoningEffort;
  return {
    model: model?.id ?? null,
    reasoningEffort:
      currentEffort && model?.reasoningEfforts.includes(currentEffort)
        ? currentEffort
        : preferredEffort(model),
  };
}

export function preferredEffort(model: ModelInfo | undefined): string | null {
  if (!model) return null;
  if (model.defaultReasoningEffort && model.reasoningEfforts.includes(model.defaultReasoningEffort))
    return model.defaultReasoningEffort;
  return model.reasoningEfforts[0] ?? null;
}

export function reasoningLabel(value: string): string {
  const labels: Record<string, string> = {
    minimal: '최소',
    low: '낮음',
    medium: '중간',
    high: '높음',
    xhigh: '매우 높음',
    ultra: '최고',
  };
  return labels[value] ?? (value || '모델 기본값');
}
