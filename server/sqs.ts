import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import type { WakeupMessage, Wakeups } from "./worker.ts";

const WAIT_SECONDS = 20;
const MAX_MESSAGES = 1;

export class SqsWakeups implements Wakeups {
  private readonly client: SQSClient;

  constructor(
    private readonly queueUrl: string,
    region: string,
  ) {
    this.client = new SQSClient({ region });
  }

  async send(jobId: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: JSON.stringify({ jobId }) }),
    );
  }

  async receive(): Promise<WakeupMessage[]> {
    const { Messages } = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        WaitTimeSeconds: WAIT_SECONDS,
        MaxNumberOfMessages: MAX_MESSAGES,
      }),
    );
    return (Messages ?? []).flatMap((message) => {
      const jobId = parseJobId(message.Body);
      return jobId && message.ReceiptHandle ? [{ jobId, receipt: message.ReceiptHandle }] : [];
    });
  }

  async extendVisibility(receipt: string, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receipt,
        VisibilityTimeout: seconds,
      }),
    );
  }

  async remove(receipt: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receipt }),
    );
  }
}

function parseJobId(body: string | undefined): string | null {
  if (!body) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    const jobId = (parsed as { jobId?: unknown }).jobId;
    return typeof jobId === "string" ? jobId : null;
  } catch {
    return null;
  }
}
