import { GenesisError, type FailureClass } from 'genesis-recon';

import { messageOf } from './reconstruction-utils';

type FailureAction = 'retrying' | 'sign-in' | 'resume' | 'fail';

const ACTION: Record<FailureClass, FailureAction> = {
    'network-interrupted': 'retrying',
    'deadline-exceeded': 'retrying',
    'credential-expired': 'retrying',
    'peer-unavailable': 'retrying',
    'quota-exceeded': 'fail',
    unauthenticated: 'sign-in',
    cancelled: 'resume',
    permanent: 'fail'
};

const TITLE: Record<FailureClass, string> = {
    'network-interrupted': 'Mất kết nối, đang thử lại',
    'deadline-exceeded': 'Quá hạn chờ, đang thử lại',
    'credential-expired': 'URL tải lên đã hết hạn, đang cấp lại',
    'peer-unavailable': 'Kho lưu trữ đang bận, đang thử lại',
    'quota-exceeded': 'Vượt hạn mức',
    unauthenticated: 'Phiên đăng nhập đã hết hạn',
    cancelled: 'Đã tạm dừng',
    permanent: 'Không thể tiếp tục'
};

const classOf = (error: unknown): FailureClass => (
    error instanceof GenesisError ? error.failureClass : 'permanent'
);

const describeFailure = (error: unknown) => {
    const failureClass = classOf(error);
    return {
        failureClass,
        action: ACTION[failureClass],
        title: TITLE[failureClass],
        detail: messageOf(error)
    };
};

export { classOf, describeFailure };
export type { FailureAction };
