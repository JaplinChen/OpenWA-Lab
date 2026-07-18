import { useTranslation } from 'react-i18next';
import { CheckCircle, XCircle } from 'lucide-react';

export interface ApiResponse {
  success: boolean;
  messageId?: string;
  timestamp: string;
  error?: string;
}

export function ResponsePanel({ response }: { response: ApiResponse | null }) {
  const { t } = useTranslation();

  return (
    <div className="response-panel">
      <h2>{t('messageTester.responseTitle')}</h2>

      {response ? (
        <>
          <div className={`response-status ${response.success ? 'success' : 'error'}`}>
            {response.success ? (
              <>
                <CheckCircle size={20} />
                <span>{t('messageTester.successLabel')}</span>
              </>
            ) : (
              <>
                <XCircle size={20} />
                <span>{t('messageTester.failedLabel')}</span>
              </>
            )}
          </div>

          <div className="response-details">
            <div className="detail-row">
              <span className="detail-label">{t('messageTester.response.timestamp')}</span>
              <span className="detail-value">{response.timestamp}</span>
            </div>
            {response.messageId && (
              <div className="detail-row">
                <span className="detail-label">{t('messageTester.response.messageId')}</span>
                <span className="detail-value mono">{response.messageId}</span>
              </div>
            )}
            {response.error && (
              <div className="detail-row">
                <span className="detail-label">{t('messageTester.response.error')}</span>
                <span className="detail-value detail-value--error">{response.error}</span>
              </div>
            )}
          </div>

          <div className="response-json">
            <pre>{JSON.stringify(response, null, 2)}</pre>
          </div>
        </>
      ) : (
        <div className="response-empty">
          <p>{t('messageTester.responseEmpty')}</p>
        </div>
      )}
    </div>
  );
}
