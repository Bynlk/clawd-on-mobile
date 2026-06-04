package com.clawd.mobile.util

import kotlinx.serialization.json.*
import org.junit.Test
import org.junit.Assert.*

/**
 * Unit tests for [ApprovalSender] JSON payload construction.
 */
class ApprovalSenderTest {

    @Test
    fun `buildPermissionResponseJson produces correct structure`() {
        val json = ApprovalSender.buildPermissionResponseJson("req-123", "allow")
        val obj = Json.parseToJsonElement(json).jsonObject
        assertEquals("permission_response", obj["type"]?.jsonPrimitive?.content)
        assertEquals("req-123", obj["id"]?.jsonPrimitive?.content)
        assertEquals("allow", obj["decision"]?.jsonPrimitive?.content)
        assertNull(obj["suggestionIndex"])
    }

    @Test
    fun `buildPermissionResponseJson with suggestion index`() {
        val json = ApprovalSender.buildPermissionResponseJson("req-123", "allow", suggestionIndex = 2)
        val obj = Json.parseToJsonElement(json).jsonObject
        assertEquals(2, obj["suggestionIndex"]?.jsonPrimitive?.int)
    }

    @Test
    fun `buildPermissionResponseJson with deny decision`() {
        val json = ApprovalSender.buildPermissionResponseJson("req-456", "deny")
        val obj = Json.parseToJsonElement(json).jsonObject
        assertEquals("deny", obj["decision"]?.jsonPrimitive?.content)
    }

    @Test
    fun `buildElicitationResponseJson with empty answers`() {
        val json = ApprovalSender.buildElicitationResponseJson("req-789", null, emptyMap())
        val obj = Json.parseToJsonElement(json).jsonObject
        assertEquals("elicitation_response", obj["type"]?.jsonPrimitive?.content)
        assertEquals("req-789", obj["id"]?.jsonPrimitive?.content)
        assertEquals("allow", obj["decision"]?.jsonPrimitive?.content)
    }

    @Test
    fun `buildElicitationResponseJson with answers`() {
        val answers = mapOf("question1" to "answer1", "question2" to "answer2")
        val json = ApprovalSender.buildElicitationResponseJson("req-789", null, answers)
        val obj = Json.parseToJsonElement(json).jsonObject
        val updatedInput = obj["updatedInput"]?.jsonObject!!
        val answersObj = updatedInput["answers"]?.jsonObject!!
        assertEquals("answer1", answersObj["question1"]?.jsonPrimitive?.content)
        assertEquals("answer2", answersObj["question2"]?.jsonPrimitive?.content)
    }
}
