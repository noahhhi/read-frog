// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://bugs.kde.org/show_bug.cgi?id=527012"}
import { afterEach, describe, expect, it } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { PARAGRAPH_ATTRIBUTE, WALKED_ATTRIBUTE } from "@/utils/constants/dom-labels"
import { extractTextContent, walkAndLabelElement } from "../traversal"

afterEach(() => {
  document.body.replaceChildren()
})

describe("KDE Bugzilla comments", () => {
  it("translates description and comment prose while preserving excluded content", () => {
    document.body.innerHTML = `
      <div class="bz_comment">
        <div class="bz_first_comment_head">Description author and timestamp</div>
        <pre class="bz_comment_text">The background service holds a multicast lock.

Steps to reproduce:
1. Connect the phone to Wi-Fi.
2. Leave the service running.</pre>
      </div>
      <div class="bz_comment">
        <div class="bz_comment_head">Comment author and timestamp</div>
        <pre class="bz_comment_text">Created <span><a href="attachment.cgi?id=1">attachment 1</a></span>
Diagnostic excerpts</pre>
      </div>
      <pre id="code">const answer = 42</pre>
      <textarea>Unsubmitted comment draft</textarea>
      <div class="related_actions">Reply</div>
    `
    walkAndLabelElement(document.body, "kde", DEFAULT_CONFIG)

    for (const comment of document.querySelectorAll<HTMLElement>(".bz_comment_text")) {
      expect(comment).toHaveAttribute(PARAGRAPH_ATTRIBUTE)
      const extracted = extractTextContent(comment, DEFAULT_CONFIG)
      for (const line of comment.textContent.trim().split("\n").filter(Boolean)) {
        expect(extracted).toContain(line)
      }
    }
    for (const excluded of document.querySelectorAll(
      ".bz_first_comment_head, .bz_comment_head, .related_actions, #code, textarea",
    )) {
      expect(excluded).not.toHaveAttribute(WALKED_ATTRIBUTE)
      expect(excluded).not.toHaveAttribute(PARAGRAPH_ATTRIBUTE)
    }
  })

  it("keeps PRE blocked when the KDE rule is disabled", () => {
    document.body.innerHTML = '<pre class="bz_comment_text">Issue description</pre>'
    const config = structuredClone(DEFAULT_CONFIG)
    config.siteRules.disabledBuiltInRules = ["bugsKde"]
    walkAndLabelElement(document.body, "disabled", config)
    expect(document.querySelector("pre")).not.toHaveAttribute(WALKED_ATTRIBUTE)
  })
})
