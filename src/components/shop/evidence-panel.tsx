import { Card, CardBody } from "@/components/ui";
import { StarDisplay } from "@/components/reviews/star-rating";
import type { EvidenceChunk } from "@/server/catalog/evidence";

/**
 * What buyers actually said, grouped by the question it answers.
 *
 * This sits beside the quality bars rather than replacing them, because they do
 * different jobs. `breathability: 4` is a summary — compact, sortable, and
 * meaningless to a person deciding whether their feet will cook in July. The
 * sentence underneath it is the evidence for that number, in the words of
 * someone who bought the thing.
 *
 * Every line here is retrieved, never generated: the text is a real review body
 * and the star rating beside it is that reviewer's own. Nothing is summarised,
 * so there is nothing for a model to get wrong.
 */
export function EvidencePanel({
  topics,
}: {
  topics: { topic: string; chunks: EvidenceChunk[] }[];
}) {
  if (topics.length === 0) return null;

  return (
    <Card>
      <CardBody className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold">What buyers say about it</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Pulled from this product&rsquo;s own reviews by searching what people wrote, then grouped
            under the question each answers. Quoted, never summarised.
          </p>
        </div>

        <dl className="space-y-4">
          {topics.map(({ topic, chunks }) => (
            <div key={topic} className="space-y-1.5">
              <dt className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {humanise(topic)}
              </dt>
              {chunks.map((chunk) => (
                <dd key={chunk.chunkId} className="border-l-2 border-border pl-3">
                  <p className="text-sm">&ldquo;{chunk.body}&rdquo;</p>
                  {chunk.ratingBp ? (
                    <div className="mt-1">
                      <StarDisplay stars={chunk.ratingBp / 1000} />
                    </div>
                  ) : null}
                </dd>
              ))}
            </div>
          ))}
        </dl>
      </CardBody>
    </Card>
  );
}

/** Quality keys arrive camelCased from the catalogue's own attributes. */
function humanise(value: string): string {
  const spaced = value.replace(/([a-z])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
