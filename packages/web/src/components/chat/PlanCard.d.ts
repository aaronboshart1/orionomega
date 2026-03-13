import type { PlanData } from '@/stores/orchestration';
interface PlanCardProps {
    plan: PlanData;
    onRespond: (planId: string, action: string, modification?: string) => void;
}
export declare function PlanCard({ plan, onRespond }: PlanCardProps): import("react").JSX.Element;
export {};
//# sourceMappingURL=PlanCard.d.ts.map