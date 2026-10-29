import XCTest

final class AppearanceUITests: XCTestCase {
    private let originalAppearance = XCUIDevice.shared.appearance
    override func tearDown() {
        XCUIDevice.shared.appearance = originalAppearance == .unspecified ? .light : originalAppearance
        super.tearDown()
    }
    private func launch(largeText: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--touchline-ui-test", "--touchline-ui-test-reading"]
        app.launchEnvironment["TOUCHLINE_APPEARANCE_TEST_SUITE"] = UUID().uuidString
        if largeText { app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"] }
        app.launch()
        return app
    }
    private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<10 {
            if element.isHittable { break }
            let appearance = app.scrollViews["appearance-panel"]
            if appearance.exists { appearance.swipeUp() } else { app.swipeUp() }
        }
        XCTAssertTrue(element.isHittable)
    }
    private func openAppearance(_ app: XCUIApplication) {
        let trigger = app.buttons["appearance-trigger"].firstMatch
        if !trigger.waitForExistence(timeout: 3), app.buttons["ToggleSidebar"].exists { app.buttons["ToggleSidebar"].tap() }
        XCTAssertTrue(trigger.waitForExistence(timeout: 10)); trigger.tap()
        XCTAssertTrue(app.buttons["appearance-pair-bloom"].waitForExistence(timeout: 5))
    }
    private func capture(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
    func testAppearancePairsModesAndPersistence() {
        XCUIDevice.shared.appearance = .dark
        let app = launch()
        openAppearance(app)
        if app.windows.firstMatch.frame.width > 600 {
            XCTAssertGreaterThanOrEqual(app.popovers.firstMatch.frame.width, 350)
        }
        XCTAssertLessThanOrEqual(app.buttons["appearance-mode-system"].frame.height, 48)
        for (pair, dark, light) in [("bloom", "Noir Bloom", "Confetti Studio"), ("coast", "Dusk Protocol", "Coastal Day")] {
            app.buttons["appearance-pair-" + pair].tap()
            for (mode, expected) in [("dark", dark), ("light", light), ("system", dark)] {
                app.buttons["appearance-mode-" + mode].tap()
                XCTAssertEqual(app.staticTexts["appearance-current"].label, expected)
                XCTAssertTrue(app.buttons["appearance-mode-" + mode].isSelected)
                XCTAssertTrue(app.buttons["appearance-pair-" + pair].isSelected)
            }
            XCUIDevice.shared.appearance = .light
            XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "identifier == %@ AND label == %@", "appearance-current", light)).firstMatch.waitForExistence(timeout: 5))
            capture(app, "P13 " + pair + " light")
            XCUIDevice.shared.appearance = .dark
            XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "identifier == %@ AND label == %@", "appearance-current", dark)).firstMatch.waitForExistence(timeout: 5))
            capture(app, "P13 " + pair + " dark")
        }
        app.buttons["appearance-done"].tap()
        app.terminate(); app.launch(); openAppearance(app)
        XCTAssertTrue(app.buttons["appearance-pair-coast"].isSelected)
        XCTAssertTrue(app.buttons["appearance-mode-system"].isSelected)
        XCTAssertEqual(app.staticTexts["appearance-current"].label, "Dusk Protocol")
    }
    func testAppearanceKeepsCurrentLessonAndDismisses() {
        let app = launch()
        let first = app.buttons["course-reading-one-downloaded"]
        if !first.waitForExistence(timeout: 3), app.buttons["ToggleSidebar"].exists { app.buttons["ToggleSidebar"].tap() }
        XCTAssertTrue(first.waitForExistence(timeout: 10)); first.tap()
        let resume = app.buttons["continue-reading"]; reveal(resume, in: app); resume.tap()
        XCTAssertTrue(app.navigationBars["Start with a forecast"].waitForExistence(timeout: 5))
        openAppearance(app)
        app.buttons["appearance-pair-coast"].tap()
        app.buttons["appearance-mode-dark"].tap()
        if app.windows.firstMatch.frame.width > 600 {
            XCTAssertTrue(app.popovers.firstMatch.exists)
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.9)).tap()
        } else {
            app.buttons["appearance-done"].tap()
        }
        XCTAssertTrue(app.buttons["appearance-done"].waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.navigationBars["Start with a forecast"].exists)
        let notes = app.staticTexts["First course notes"]; reveal(notes, in: app)
        XCTAssertTrue(notes.exists)
        XCTAssertFalse(app.staticTexts["Second course notes"].exists)
    }
    func testAppearanceSupportsLargestText() {
        let app = launch(largeText: true)
        openAppearance(app)
        let coast = app.buttons["appearance-pair-coast"]; reveal(coast, in: app); coast.tap()
        let light = app.buttons["appearance-mode-light"]; reveal(light, in: app); light.tap()
        let current = app.staticTexts["appearance-current"]; reveal(current, in: app)
        XCTAssertEqual(current.label, "Coastal Day")
        let done = app.buttons["appearance-done"]; reveal(done, in: app)
        XCTAssertGreaterThanOrEqual(done.frame.height, 44)
        capture(app, "P13 largest text")
        done.tap()
        XCTAssertTrue(done.waitForNonExistence(timeout: 5))
    }
}
