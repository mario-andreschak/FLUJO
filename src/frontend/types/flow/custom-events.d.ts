// Custom event type definitions
export interface EditNodeEventDetail {
  nodeId: string;
}

interface EditNodeEvent extends CustomEvent {
  detail: EditNodeEventDetail;
}

declare global {
  interface DocumentEventMap {
    'editNode': EditNodeEvent;
  }
}

export {};
