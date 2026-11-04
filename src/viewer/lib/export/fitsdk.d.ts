declare module "@garmin/fitsdk" {
  export interface DecoderOptions {
    mesgListener?: (messageNumber: number, message: Record<string, unknown>) => void;
  }

  export class Stream {
    static fromByteArray(bytes: number[]): Stream;
  }

  export class Decoder {
    constructor(stream: Stream);
    static isFIT(stream: Stream): boolean;
    isFIT(): boolean;
    checkIntegrity(): boolean;
    read(options?: DecoderOptions): {
      messages: Record<string, unknown[]>;
      errors: unknown[];
    };
  }

  export class Encoder {
    onMesg(mesgNum: number, data: Record<string, unknown>): void;
    close(): Uint8Array;
  }

  export const Profile: {
    MesgNum: {
      FILE_ID: number;
      WORKOUT: number;
      WORKOUT_STEP: number;
    };
  };
}
