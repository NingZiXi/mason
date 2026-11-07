import { ElMessage, ElMessageBox } from 'element-plus';
import { useI18n } from 'vue-i18n';
import { useWorkSessionStore } from '../stores/work-session';

export function useExitConfirmation() {
  const session = useWorkSessionStore();
  const { t } = useI18n();
  return async () => {
    if (session.exporting) {
      ElMessage.info(t('exit.exporting'));
      return false;
    }
    return session.confirmExit(async () => {
      try {
        await ElMessageBox.confirm(t('exit.message'), t('exit.title'), {
          confirmButtonText: t('exit.leave'), cancelButtonText: t('exit.stay'),
          customClass: 'stencil-review-dialog exit-review-dialog', buttonSize: 'default',
          confirmButtonClass: 'stencil-review-confirm', cancelButtonClass: 'stencil-review-back',
          distinguishCancelAndClose: true, closeOnClickModal: false, autofocus: false,
          modalClass: 'app-confirm-overlay',
        });
        return true;
      } catch { return false; }
    });
  };
}
