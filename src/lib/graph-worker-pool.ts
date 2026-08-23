import { Annotation, END, START, Send, StateGraph } from "@langchain/langgraph";

const DISPATCH_NODE = "dispatch_workers";
const WORKER_NODE = "run_worker";
const WORKER_GRAPH_NAME = "bounded_worker_pool";

interface IndexedJob<Input> {
  index: number;
  value: Input;
}

interface IndexedResult<Output> {
  index: number;
  value: Output;
}

/**
 * Execute dynamically dispatched LangGraph workers with bounded concurrency.
 * @param values values to process
 * @param concurrency maximum simultaneously active graph workers
 * @param worker asynchronous worker receiving one value and original index
 * @param signal optional request cancellation signal
 * @returns worker results restored to input order
 */
export async function runGraphWorkerPool<Input, Output>(
  values: Input[],
  concurrency: number,
  worker: (value: Input, index: number) => Promise<Output>,
  signal?: AbortSignal,
): Promise<Output[]> {
  if (values.length === 0) return [];
  const WorkerStateAnnotation = Annotation.Root({
    jobs: Annotation<IndexedJob<Input>[]>({
      reducer: (_current, update) => update,
      default: () => [],
    }),
    job: Annotation<IndexedJob<Input> | null>({
      reducer: (_current, update) => update,
      default: () => null,
    }),
    results: Annotation<IndexedResult<Output>[]>({
      reducer: (current, update) => current.concat(update),
      default: () => [],
    }),
  });
  const graph = new StateGraph(WorkerStateAnnotation)
    .addNode(DISPATCH_NODE, () => ({}))
    .addNode(WORKER_NODE, async (state) => {
      if (!state.job) return { results: [] };
      signal?.throwIfAborted();
      const value = await worker(state.job.value, state.job.index);
      return { results: [{ index: state.job.index, value }] };
    })
    .addEdge(START, DISPATCH_NODE)
    .addConditionalEdges(DISPATCH_NODE, (state) =>
      state.jobs.map(
        (job) =>
          new Send(WORKER_NODE, {
            jobs: [],
            job,
            results: [],
          }),
      ),
    )
    .addEdge(WORKER_NODE, END)
    .compile({ name: WORKER_GRAPH_NAME });
  const finalState = await graph.invoke(
    {
      jobs: values.map((value, index) => ({ index, value })),
      job: null,
      results: [],
    },
    { maxConcurrency: Math.max(1, concurrency), signal },
  );
  return finalState.results
    .sort((left, right) => left.index - right.index)
    .map((result) => result.value);
}
