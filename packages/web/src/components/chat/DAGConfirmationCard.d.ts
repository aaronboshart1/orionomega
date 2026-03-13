import type { DAGConfirmation } from '@/stores/orchestration';
interface DAGConfirmationCardProps {
    confirmation: DAGConfirmation;
    onRespond: (dagId: string, approved: boolean) => void;
}
export declare function DAGConfirmationCard({ confirmation, onRespond }: DAGConfirmationCardProps): import("react").JSX.Element;
export {};
//# sourceMappingURL=DAGConfirmationCard.d.ts.map