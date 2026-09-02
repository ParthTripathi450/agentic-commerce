/**
 * Component barrel.
 *
 * shadcn owns the primitives; this file exposes them under the names the app's
 * pages already use, plus the few tone-aware pieces shadcn does not provide.
 */
export { Card, CardHeader, CardTitle, CardDescription, CardFooter, CardAction } from "./card";
export { CardContent, CardContent as CardBody } from "./card";
export { Input } from "./input";
export { Textarea } from "./textarea";
export { Label } from "./label";
export { Separator } from "./separator";
export { Skeleton } from "./skeleton";
export { Avatar, AvatarImage, AvatarFallback } from "./avatar";
export {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
} from "./table";

export { Button, LinkButton, type AppButtonProps } from "./app-button";
export { Badge } from "./app-badge";
export { Alert } from "./app-alert";
export { Field, Select, EmptyState } from "./field";
export { toneStyles, type Tone } from "./tone";
