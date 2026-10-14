import { Bell, BellOff } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from './api';
import { isNativeApp, NativeBridgeError, openNativeNotificationSettings } from './native-bridge';
import { NativeNotificationUnavailable, refreshNativeNotifications } from './native-notifications';
import {
  disableNotifications,
  enableNotifications,
  localNotificationSubscription,
  type NotificationStatus,
  notificationStatus,
  notificationSupport,
  saveNotificationPreference,
} from './notification-client';
import { Button, ErrorNotice } from './primitives';
import './notifications.css';
export function NotificationPanel() {
  const [status, setStatus] = useState<NotificationStatus | null>(null),
    [actionError, setActionError] = useState(''),
    [refreshError, setRefreshError] = useState(''),
    [busy, setBusy] = useState(false);
  const supported = notificationSupport();
  const native = isNativeApp();
  const refreshVersion = useRef(0);
  const savingPreference = useRef(false);
  const [preferenceBusy, setPreferenceBusy] = useState(false);
  const [deviceConfigured, setDeviceConfigured] = useState(true);
  const [permission, setPermission] = useState<NotificationPermission>(
    !native && supported ? Notification.permission : 'default',
  );
  const [localSubscribed, setLocalSubscribed] = useState(false);
  const refresh = useCallback(async () => {
    if (savingPreference.current) return;
    const version = ++refreshVersion.current;
    try {
      if (isNativeApp()) {
        const { device, server } = await refreshNativeNotifications();
        if (version !== refreshVersion.current) return;
        setStatus(server);
        setDeviceConfigured(device.configured);
        setLocalSubscribed(!!device.token);
        setPermission(device.permission);
        setRefreshError('');
        return;
      }
      const [next, local] = await Promise.all([notificationStatus(), localNotificationSubscription()]);
      if (version !== refreshVersion.current) return;
      setStatus(next);
      setLocalSubscribed(local);
      setPermission(notificationSupport() ? Notification.permission : 'default');
      setRefreshError('');
    } catch (failure) {
      if (version === refreshVersion.current) setRefreshError(notificationError(failure));
    }
  }, []);
  useEffect(() => {
    void refresh();
    const focus = () => void refresh();
    window.addEventListener('focus', focus);
    window.addEventListener('assistant-native-notification-state', focus);
    return () => {
      refreshVersion.current++;
      window.removeEventListener('focus', focus);
      window.removeEventListener('assistant-native-notification-state', focus);
    };
  }, [refresh]);
  const enable = async () => {
    if (!status?.configured || (!native && !status.public_key)) return;
    refreshVersion.current++;
    setBusy(true);
    setActionError('');
    setRefreshError('');
    try {
      setPermission(await enableNotifications(status.public_key));
      await refresh();
    } catch (failure) {
      setActionError(notificationError(failure));
    } finally {
      setBusy(false);
    }
  };
  const disable = async () => {
    refreshVersion.current++;
    setBusy(true);
    setActionError('');
    setRefreshError('');
    try {
      await disableNotifications();
      await refresh();
    } catch (failure) {
      setActionError(notificationError(failure));
    } finally {
      setBusy(false);
    }
  };
  const openSettings = async () => {
    setBusy(true);
    setActionError('');
    setRefreshError('');
    try {
      await openNativeNotificationSettings();
    } catch (failure) {
      setActionError(notificationError(failure));
    } finally {
      setBusy(false);
    }
  };
  const saveContent = async (showContent: boolean) => {
    if (savingPreference.current) return;
    savingPreference.current = true;
    refreshVersion.current++;
    setPreferenceBusy(true);
    setActionError('');
    try {
      const saved = await saveNotificationPreference(showContent);
      setStatus(previous => previous ? { ...previous, show_content: saved } : previous);
    } catch (failure) {
      setActionError(notificationError(failure));
    } finally {
      savingPreference.current = false;
      setPreferenceBusy(false);
    }
  };
  const error = actionError || refreshError;
  const active =
    status?.configured && deviceConfigured && status.enabled && localSubscribed && permission === 'granted';
  return (
    <section className="notification-panel" aria-label="알림 설정">
      <p className="notification-description">
        {active ? <Bell size={15} aria-hidden="true" /> : <BellOff size={15} aria-hidden="true" />}
        어시스턴트가 보낸 메시지를 이 기기에 알림으로 보여 줘요.
      </p>
      {status && (
        <label className="notification-preference">
          <input type="checkbox" checked={status.show_content} disabled={preferenceBusy}
            onChange={event => void saveContent(event.target.checked)} />
          <span>알림에 메시지 내용 표시<small>모든 기기에 적용돼요. 끄면 이름과 ‘새 메시지’만 표시해요.</small></span>
        </label>
      )}
      {preferenceBusy && <p className="notification-note" role="status">설정을 저장하고 있어요.</p>}
      <div className="notification-status" role="status">
        {!status
          ? '알림 설정을 확인하고 있어요.'
          : !deviceConfigured
            ? '이 앱의 알림 서비스가 아직 준비되지 않았어요. 대화 안에서는 결과를 계속 확인할 수 있어요.'
            : !status.configured
              ? '아직 알림 서비스를 사용할 수 없어요. 대화 안에서는 결과를 계속 확인할 수 있어요.'
              : !supported
                ? '이 브라우저에서는 알림을 사용할 수 없어요. iPhone과 iPad에서는 홈 화면에 추가한 앱으로 열어 주세요.'
                : permission === 'denied'
                  ? native
                    ? '기기에서 알림이 차단됐어요. 시스템 알림 설정에서 권한을 변경할 수 있어요.'
                    : '브라우저에서 알림이 차단됐어요. 브라우저 설정에서 권한을 변경할 수 있어요.'
                  : active
                    ? '이 기기 알림이 켜져 있어요.'
                    : '알림이 꺼져 있어요. 원하는 때 켤 수 있어요.'}
      </div>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      <div className="notification-actions">
        <Button
          onClick={() => void enable()}
          disabled={
            !status?.configured || !deviceConfigured || !supported || permission === 'denied' || !!active
          }
          busy={busy}
        >
          이 기기에서 알림 받기
        </Button>
        {native && permission === 'denied' && (
          <Button onClick={() => void openSettings()} busy={busy}>
            시스템 알림 설정 열기
          </Button>
        )}
        {status?.enabled && (
          <Button onClick={() => void disable()} busy={busy}>
            이 기기 알림 끄기
          </Button>
        )}
        {!status && error && <Button onClick={() => void refresh()}>다시 시도</Button>}
      </div>
      <p className="notification-note">
        로그아웃하거나 연결이 만료되면 전송이 중단돼요. 기기 상태와 집중 모드에 따라 알림이 늦어지거나
        표시되지 않을 수 있어요.
      </p>
    </section>
  );
}

function notificationError(error: unknown): string {
  return error instanceof NativeBridgeError || error instanceof NativeNotificationUnavailable
    ? error.message
    : errorMessage(error);
}
