package com.openmausbot.companion.core

import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer

/**
 * A screen's rememberCoroutineScope is cancelled when the screen leaves the
 * composition (LeftCompositionCancellationException). That is the caller
 * going away, not a failure: the action must propagate the cancellation and
 * leave actionError alone, or RootScreen shows "rememberCoroutineScope left
 * the composition" as an error dialog.
 */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class SessionActionCancellationTest {
    private lateinit var server: MockWebServer

    @BeforeTest
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @AfterTest
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun createBotCancelledMidRequestDoesNotReportAnError() = runTest {
        val session = session()
        // No response is queued, so the POST stays in flight until cancelled.
        val screen = CoroutineScope(coroutineContext + Job())
        val creating = screen.async(start = CoroutineStart.UNDISPATCHED) { session.createBot() }

        val request = assertNotNull(server.takeRequest(5, TimeUnit.SECONDS))
        assertEquals("POST /api/bots", "${request.method} ${request.path}")
        screen.cancel(CancellationException("rememberCoroutineScope left the composition"))

        assertFailsWith<CancellationException> { creating.await() }
        assertNull(session.actionError)
    }

    @Test
    fun openCancelledMidRefreshDoesNotReportAnError() = runTest {
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        var holdHydrate = false
        val session = session {
            if (holdHydrate) {
                started.complete(Unit)
                release.await()
            }
            Fleet(emptyList(), emptyList())
        }
        holdHydrate = true
        // The hit names a bot this phone has not loaded yet, so open refreshes
        // the fleet first — the call that is in flight when the screen leaves.
        val hit = SearchHit(
            threadId = "task-1",
            messageId = "m1",
            at = 1.0,
            role = Message.Role.USER,
            kind = Message.Kind.TEXT,
            snippet = "hello",
            matchStart = 0,
            matchLength = 5,
            botId = "b1",
            name = "b1",
            onActivePath = true,
        )
        val screen = CoroutineScope(coroutineContext + Job())
        val opening = screen.async { session.open(hit) }
        try {
            started.await()
            screen.cancel(CancellationException("rememberCoroutineScope left the composition"))
        } finally {
            release.complete(Unit)
        }

        assertFailsWith<CancellationException> { opening.await() }
        assertNull(session.actionError)
    }

    @Test
    fun cancellationPropagatesThroughEveryReportingActionWithoutReportingAnError() = runTest {
        val session = session()
        val host = bot("b1", "task-1")
        val chat = Chat.BotChat(host)
        val message = Message("m1", Message.Role.BOT, Message.Kind.TEXT, 1.0, text = "hi")
        val cancelled = CoroutineScope(coroutineContext + Job().apply { cancel() })

        val operations: List<suspend () -> Unit> = listOf(
            { session.createBot() },
            { session.createRoom("Room", listOf("b1")) },
            { session.assignSection("Section", listOf("b1")) },
            { session.search("hello") },
            { session.react(message, "task-1", "👍") },
            { session.switchVersion(message, host) },
            { session.export("task-1", "markdown") },
            { session.send("hello", chat) },
            { session.interrupt(host) },
        )

        operations.forEachIndexed { index, operation ->
            // Undispatched so the body runs into its HTTP call and surfaces
            // the already-cancelled job's CancellationException through its catch.
            val deferred = cancelled.async(start = CoroutineStart.UNDISPATCHED) { operation() }
            assertFailsWith<CancellationException>("operation $index") { deferred.await() }
        }

        assertNull(session.actionError)
    }

    @Test
    fun aRealFailureIsStillReported() = runTest {
        val session = session()
        server.enqueue(
            MockResponse()
                .setResponseCode(500)
                .setHeader("Content-Type", "application/json")
                .setBody("""{"error":"Create failed"}"""),
        )

        assertNull(session.createBot())
        assertEquals("Create failed", session.actionError)
    }

    private suspend fun TestScope.session(): Session = session { Fleet(emptyList(), emptyList()) }

    private suspend fun TestScope.session(
        hydrate: suspend () -> Fleet,
    ): Session {
        val connection = requireNotNull(Connection.parse(server.url("/").toString()))
        return Session(
            scope = backgroundScope,
            connectionStore = object : ConnectionStore {
                override suspend fun load(): Connection = connection
                override suspend fun save(connection: Connection) = Unit
                override suspend fun clear() = Unit
                override suspend fun loadRegistry() = ConnectionRegistryRestore(
                    ConnectionRegistry(listOf(connection), connection.id),
                    migratedLegacyConnection = false,
                )
            },
            tokenStore = object : TokenStore {
                override suspend fun save(connectionId: String, token: String) = Unit
                override suspend fun read(connectionId: String): TokenStore.ReadResult =
                    TokenStore.ReadResult.Found("device-token")
                override suspend fun remove(connectionId: String) = Unit
            },
            onboardingStore = InMemoryOnboardingStore(),
            deviceNameProvider = { "Pixel" },
            eventsFn = { _, _, _ -> emptyFlow() },
            hydrateFn = { _, _ -> hydrate() },
        ).also { it.awaitRestored() }
    }

    private fun bot(id: String, active: String): Bot = Bot(
        id = id,
        threadId = active,
        name = id,
        title = "",
        description = "",
        notifications = true,
        color = "green",
        unread = false,
        modelSelection = ModelSelection("instance", "model"),
        createdAt = 1.0,
        tasks = listOf(BotTask(active, "Task 1", 0.0)),
    )
}
