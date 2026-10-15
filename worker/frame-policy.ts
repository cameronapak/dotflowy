/**
 * Who may frame the app: the app itself and the landing page at
 * dotflowy.com, which frames the live demo (`/demo`). Nobody else may frame
 * any page, so a hostile site can't overlay the editor or the OAuth consent
 * screen to steal clicks. Local landing dev frames the Vite app server
 * (`VITE_DEMO_APP_URL`), which never runs this Worker.
 */
export const FRAME_ANCESTORS = "frame-ancestors 'self' https://dotflowy.com";

/** The asset response with the frame policy attached (asset headers are
 *  immutable, so this copies the response). */
export function withFramePolicy(response: Response): Response {
  const framed = new Response(response.body, response);
  framed.headers.set("Content-Security-Policy", FRAME_ANCESTORS);
  return framed;
}
